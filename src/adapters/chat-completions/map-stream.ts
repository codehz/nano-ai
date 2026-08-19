/**
 * ChatCompletionsAdapter — stream 映射
 */

import { WarningCode } from "../../runtime/errors.js";
import { textBlock, opaqueItem, mapStopReason } from "../../canonical/index.js";
import { createStreamingItemSession } from "../../provider/streaming-item-session.js";
import { usageFromChatCompletions } from "../../provider/usage/index.js";
import { createDataLineSseParser } from "../../provider/transport/parser.js";
import { finalizeStreamTurn } from "../../provider/finalize-stream-turn.js";
import { OPAQUE_SOURCE } from "../../provider/opaque-sources.js";

import type { NormalizedRequest, AIStreamEvent, StopReason } from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import { buildAssistantReplayMessage, extractReasoningDeltas } from "./map-request.js";
import type { ChatRequest, ChatMessage, ChatChunk, PendingToolCall, ReasoningFieldName } from "./types.js";

export {
  assertChatReplayMessages,
  buildAssistantReplayMessage,
  extractReasoningDeltas,
  extractReasoningText,
  isChatReplayMessage,
  isChatReplayToolCall,
  mapper,
} from "./map-request.js";

export type ChatCompletionsAdapterStreamHost = {
  beginJsonStream: (
    factory: EventFactory,
    request: NormalizedRequest,
  ) => import("../../provider/transport/run-json-stream.js").ProviderJsonStreamSession;
  baseUrl: string;
  apiKey?: string;
  mergeHeaders: (headers: Record<string, string>) => Record<string, string>;
  maxOpaquePayloadBytes: number;
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

  const ensurePendingToolCallStarted = (pending: PendingToolCall, events: AIStreamEvent[]): void => {
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
      factory,
      maxOpaquePayloadBytes: host.maxOpaquePayloadBytes,
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
