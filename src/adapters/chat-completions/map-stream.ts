/**
 * ChatCompletionsAdapter — stream 映射
 */

import { AIRequestError, WarningCode } from "../../runtime/errors.js";
import {
  textBlock,
  opaqueItem,
  mapStopReason,
} from "../../canonical/index.js";
import { createStreamingItemSession } from "../../provider/streaming-item-session.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";
import { usageFromChatCompletions } from "../../provider/usage/index.js";
import { createDataLineSseParser } from "../../provider/transport/parser.js";
import { finalizeStreamTurn } from "../../provider/finalize-stream-turn.js";
import { OPAQUE_SOURCE } from "../../provider/opaque-sources.js";

import type { NormalizedRequest, AIStreamEvent, StopReason } from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import {
  REASONING_FIELDS,
  type ChatRequest,
  type ChatMessage,
  type ChatToolCall,
  type ChatChunk,
  type ChatChunkChoice,
  type PendingToolCall,
  type ReasoningFieldName,
} from "./types.js";


export const mapper = new NormalizedRequestMapper("chat-completions");

export function extractReasoningText(value: unknown): string {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value.map(extractReasoningText).join("");
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "content", "reasoning", "reasoning_content", "thinking", "value"]) {
      const nested = extractReasoningText(record[key]);
      if (nested) return nested;
    }
  }

  return "";
}

export function extractReasoningDeltas(delta: ChatChunkChoice["delta"]): Array<{ field: ReasoningFieldName; text: string }> {
  const deltas: Array<{ field: ReasoningFieldName; text: string }> = [];

  for (const field of REASONING_FIELDS) {
    const text = extractReasoningText(delta[field]);
    if (text) {
      deltas.push({ field, text });
    }
  }

  return deltas;
}

export function isChatReplayToolCall(value: unknown): value is ChatToolCall {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.type !== "function") return false;
  const fn = entry.function;
  if (!fn || typeof fn !== "object") return false;
  const f = fn as Record<string, unknown>;
  return typeof f.name === "string" && typeof f.arguments === "string";
}

export function isChatReplayMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  const role = msg.role;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    return false;
  }
  if (!(msg.content === null || typeof msg.content === "string")) {
    return false;
  }
  if (msg.tool_calls !== undefined) {
    if (!Array.isArray(msg.tool_calls) || !msg.tool_calls.every(isChatReplayToolCall)) {
      return false;
    }
  }
  if (msg.tool_call_id !== undefined && typeof msg.tool_call_id !== "string") {
    return false;
  }
  if (msg.name !== undefined && typeof msg.name !== "string") {
    return false;
  }
  return true;
}

export function assertChatReplayMessages(messages: unknown, field: string): asserts messages is ChatMessage[] {
  if (!Array.isArray(messages)) {
    throw new AIRequestError(`Invalid opaque replay payload: ${field} must be an array`, "INVALID_OPAQUE_REPLAY");
  }
  for (let i = 0; i < messages.length; i++) {
    if (!isChatReplayMessage(messages[i])) {
      throw new AIRequestError(
        `Invalid opaque replay payload: ${field}[${i}] is not a valid chat message`,
        "INVALID_OPAQUE_REPLAY",
      );
    }
  }
}

export function buildAssistantReplayMessage(params: {
  content: string;
  reasoningByField: ReadonlyMap<ReasoningFieldName, string>;
  toolCalls: readonly PendingToolCall[];
}): ChatMessage | null {
  const { content, reasoningByField, toolCalls } = params;
  if (!content && reasoningByField.size === 0 && toolCalls.length === 0) return null;

  const replayMessage: ChatMessage = {
    role: "assistant",
    content: content || null,
  };

  for (const [field, text] of reasoningByField) {
    replayMessage[field] = text;
  }

  if (toolCalls.length > 0) {
    replayMessage.tool_calls = toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: toolCall.args,
      },
    }));
  }

  return replayMessage;
}


export type ChatCompletionsAdapterStreamHost = {
  beginJsonStream: (
    factory: EventFactory,
    request: NormalizedRequest,
  ) => import("../../provider/transport/run-json-stream.js").ProviderJsonStreamSession;
  baseUrl: string;
  apiKey?: string;
  mergeHeaders: (headers: Record<string, string>) => Record<string, string>;
  
};

export async function* mapChatCompletionsStream(
  host: ChatCompletionsAdapterStreamHost,
  providerRequest: ChatRequest,
  factory: EventFactory,
  request: NormalizedRequest,
): AsyncIterable<AIStreamEvent> {
  const session = host.beginJsonStream(factory, request);
  const { auxiliary, gate } = session;
  const items = createStreamingItemSession(factory);

  await session.open({
    url: `${host.baseUrl}/chat/completions`,
    headers: host.mergeHeaders({
      "Content-Type": "application/json",
      Authorization: `Bearer ${host.apiKey}`,
    }),
    body: providerRequest,
  });

  const parser = createDataLineSseParser<ChatChunk>();

  // wire 缓冲仅用于 opaque / finish 状态；item 内容账本由 items session 维护
  let responseId: string | undefined;
  let accumulatedContent = "";
  let currentMessageId = "";
  let currentReasoningId = "";
  let hasMessageStarted = false;
  let hasReasoningStarted = false;
  let warnedNonZeroChoice = false;

  // tool_calls 按 index 占位；function_call 使用独立槽位，避免与 index 0 互踩
  const pendingToolCalls = new Map<number, PendingToolCall>();
  let pendingFunctionCall: PendingToolCall | null = null;
  /** 互斥：同一轮只接受一种 tool 形态 */
  let toolCallMode: "none" | "tool_calls" | "function_call" = "none";
  const reasoningByField = new Map<ReasoningFieldName, string>();

  const allPendingToolCalls = (): PendingToolCall[] => {
    if (toolCallMode === "function_call" && pendingFunctionCall) {
      return [pendingFunctionCall];
    }
    return [...pendingToolCalls.values()];
  };

  const ensurePendingToolCallStarted = (
    pending: PendingToolCall,
    events: AIStreamEvent[],
  ): void => {
    if (pending.started) return;
    events.push(items.startToolCall(pending.id, pending.name));
    if (pending.args) {
      events.push(items.deltaToolCall(pending.id, { argumentsText: pending.args }));
    }
    pending.started = true;
  };

  const finalizePendingTurn = (): { events: AIStreamEvent[]; assistantReplayMessage: ChatMessage | null } => {
    const events: AIStreamEvent[] = [];
    const finalizedToolCalls = allPendingToolCalls();
    const finalizedReasoningByField = new Map(reasoningByField);

    if (hasReasoningStarted && items.isActive(currentReasoningId)) {
      events.push(items.completeReasoning(currentReasoningId));
    }

    if (hasMessageStarted && items.isActive(currentMessageId)) {
      events.push(items.completeMessage(currentMessageId));
    }

    for (const pending of finalizedToolCalls) {
      ensurePendingToolCallStarted(pending, events);
      if (items.isActive(pending.id)) {
        events.push(items.completeToolCall(pending.id));
      }
    }

    const assistantReplayMessage = buildAssistantReplayMessage({
      content: accumulatedContent,
      reasoningByField: finalizedReasoningByField,
      toolCalls: finalizedToolCalls,
    });

    accumulatedContent = "";
    currentMessageId = "";
    currentReasoningId = "";
    hasMessageStarted = false;
    hasReasoningStarted = false;
    pendingToolCalls.clear();
    pendingFunctionCall = null;
    toolCallMode = "none";
    reasoningByField.clear();

    return { events, assistantReplayMessage };
  };

  const emitCompleted = async function* (
    stopReason: StopReason | undefined,
    assistantReplayMessage: ChatMessage | null,
    rawResponseId: string | undefined,
  ): AsyncIterable<AIStreamEvent> {
    yield* finalizeStreamTurn(session, items, {
      stopReason,
      rawResponseId,
      opaque: assistantReplayMessage
        ? opaqueItem(OPAQUE_SOURCE.CHAT_COMPLETIONS, "replay", {
            replaceCanonical: true,
            messages: [assistantReplayMessage],
          })
        : null,
    });
  };

  for await (const batch of session.batches({
    parser,
    providerLabel: "Chat Completions",
    transportLabel: "SSE event(s)",
    incompleteMessage: "Stream ended with an incomplete Chat Completions SSE frame",
  })) {
    for (const warning of batch.warnings) yield warning;

    for (const chunk of batch.items) {
      responseId = chunk.id;

      if (chunk.usage) {
        auxiliary.recordUsage(usageFromChatCompletions(chunk.usage), "final", chunk.usage);
      }

      for (const choice of chunk.choices) {
        if (choice.index !== 0) {
          if (!warnedNonZeroChoice) {
            yield factory.responseWarning(
              `Chat Completions returned choice index ${choice.index}; only the first choice (index 0) is supported. This choice is ignored.`,
              WarningCode.MULTIPLE_CHOICES_IGNORED,
            );
            warnedNonZeroChoice = true;
          }
          continue;
        }

        if (gate.completed) {
          if (choice.finish_reason) {
            yield factory.responseWarning("Duplicate finish signal ignored", WarningCode.DUPLICATE_FINISH);
          }
          continue;
        }

        const delta = choice.delta;
        const finishReason = choice.finish_reason;
        const reasoningDeltas = extractReasoningDeltas(delta);

        const ensureMessageStarted = function* (): Generator<AIStreamEvent> {
          if (!currentMessageId) currentMessageId = `msg-${chunk.id}`;
          const started = items.ensureMessageStarted(currentMessageId);
          if (started) {
            hasMessageStarted = true;
            yield started;
          }
        };

        const ensureReasoningStarted = function* (): Generator<AIStreamEvent> {
          if (!currentReasoningId) currentReasoningId = `reason-${chunk.id}`;
          const started = items.ensureReasoningStarted(currentReasoningId, "full");
          if (started) {
            hasReasoningStarted = true;
            yield started;
          }
        };

        if (reasoningDeltas.length > 0) {
          yield* ensureReasoningStarted();

          for (const reasoningDelta of reasoningDeltas) {
            reasoningByField.set(
              reasoningDelta.field,
              (reasoningByField.get(reasoningDelta.field) ?? "") + reasoningDelta.text,
            );
            yield items.deltaReasoning(currentReasoningId, textBlock(reasoningDelta.text));
          }
        }

        if (delta.content) {
          yield* ensureMessageStarted();
          accumulatedContent += delta.content;
          yield items.deltaMessage(currentMessageId, textBlock(delta.content));
        }

        if (delta.tool_calls) {
          yield* ensureMessageStarted();

          if (toolCallMode === "function_call") {
            yield factory.responseWarning(
              "Chat Completions mixed function_call and tool_calls; keeping tool_calls and discarding function_call state",
              WarningCode.CAPABILITY_DOWNGRADE,
            );
            if (pendingFunctionCall?.started && items.isActive(pendingFunctionCall.id)) {
              // 已 start 的 legacy call 无法撤销 id；完成空壳以免协议挂起
              yield items.completeToolCall(pendingFunctionCall.id);
            }
            pendingFunctionCall = null;
          }
          toolCallMode = "tool_calls";

          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            let pending = pendingToolCalls.get(idx);
            if (!pending) {
              pending = {
                id: tc.id ?? `pending-tc-${chunk.id}-${idx}`,
                name: tc.function?.name ?? "",
                args: "",
                started: false,
                hasProviderId: Boolean(tc.id),
              };
              pendingToolCalls.set(idx, pending);
            } else {
              if (tc.id && !pending.hasProviderId) {
                // start 前可替换占位 id
                if (!pending.started) {
                  pending.id = tc.id;
                }
                pending.hasProviderId = true;
              }
              if (tc.function?.name) {
                pending.name = tc.function.name;
              }
            }

            if (tc.id && !pending.started) {
              pending.id = tc.id;
              pending.hasProviderId = true;
              pending.started = true;
              yield items.startToolCall(pending.id, pending.name);
              if (pending.args) {
                yield items.deltaToolCall(pending.id, { argumentsText: pending.args });
              }
            }

            if (tc.function?.arguments) {
              pending.args += tc.function.arguments;
              if (pending.started) {
                yield items.deltaToolCall(pending.id, { argumentsText: tc.function.arguments });
              }
            }
          }
        }

        if (delta.function_call) {
          yield* ensureMessageStarted();

          if (toolCallMode === "tool_calls") {
            yield factory.responseWarning(
              "Chat Completions mixed tool_calls and function_call; ignoring legacy function_call for this turn",
              WarningCode.CAPABILITY_DOWNGRADE,
            );
          } else {
            toolCallMode = "function_call";

            if (!pendingFunctionCall) {
              pendingFunctionCall = {
                id: `fc-${chunk.id}-0`,
                name: delta.function_call.name ?? "",
                args: "",
                started: false,
                hasProviderId: true,
              };
            }

            if (delta.function_call.name) {
              pendingFunctionCall.name = delta.function_call.name;
            }

            if (!pendingFunctionCall.started && pendingFunctionCall.name) {
              pendingFunctionCall.started = true;
              yield items.startToolCall(pendingFunctionCall.id, pendingFunctionCall.name);
              if (pendingFunctionCall.args) {
                yield items.deltaToolCall(pendingFunctionCall.id, {
                  argumentsText: pendingFunctionCall.args,
                });
              }
            }

            if (delta.function_call.arguments) {
              pendingFunctionCall.args += delta.function_call.arguments;
              if (pendingFunctionCall.started) {
                yield items.deltaToolCall(pendingFunctionCall.id, {
                  argumentsText: delta.function_call.arguments,
                });
              }
            }
          }
        }

        if (finishReason && finishReason !== null) {
          const { events, assistantReplayMessage } = finalizePendingTurn();
          for (const event of events) yield event;
          yield* emitCompleted(mapStopReason(finishReason), assistantReplayMessage, chunk.id);
        }
      }
    }
  }

  if (
    !gate.completed &&
    (hasMessageStarted || hasReasoningStarted || pendingToolCalls.size > 0 || pendingFunctionCall !== null)
  ) {
    yield factory.responseWarning("Stream ended without a finish_reason", WarningCode.STREAM_INCOMPLETE);
    const { events, assistantReplayMessage } = finalizePendingTurn();
    for (const event of events) yield event;
    yield* emitCompleted(undefined, assistantReplayMessage, responseId);
  }
}
