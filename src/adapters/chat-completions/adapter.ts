/**
 * Chat Completions Adapter
 *
 * 接入 OpenAI Chat Completions API (chat/completions 端点)。
 * 弱能力兼容层：
 * - third-party reasoning 字段仅做 best-effort 提取
 * - 工具调用通常整块到达（非逐 token 流）
 * - replay fidelity 依赖 provider 是否暴露可回放的 assistant turn 字段
 */

import { HttpAdapterBase } from "../../provider/http-adapter.js";
import { AIRequestError, WarningCode } from "../../runtime/errors.js";
import {
  textBlock,
  opaqueItem,
  replayFromOutput,
  mapStopReason,
} from "../../canonical/index.js";
import { acceptOpaqueReplay } from "../../provider/opaque-replay.js";
import { createStreamingItemSession } from "../../provider/streaming-item-session.js";
import { usageFromChatCompletions } from "../../provider/usage/index.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";
import { createChatCompletionsSseParser } from "../../provider/transport/parser.js";
import { mapChatCompletionsReasoningEffort } from "../../provider/reasoning.js";

import type { NormalizedRequest, AIStreamEvent, StopReason } from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";

// ── 类型 ──────────────────────────────────────────────────────

import {
  REASONING_FIELDS,
  type ChatCompletionsAdapterOptions,
  type ChatRequest,
  type ChatMessage,
  type ChatToolCall,
  type ChatTool,
  type ChatChunk,
  type ChatChunkChoice,
  type PendingToolCall,
  type ReasoningFieldName,
} from "./types.js";

const mapper = new NormalizedRequestMapper("chat-completions");

function extractReasoningText(value: unknown): string {
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

function extractReasoningDeltas(delta: ChatChunkChoice["delta"]): Array<{ field: ReasoningFieldName; text: string }> {
  const deltas: Array<{ field: ReasoningFieldName; text: string }> = [];

  for (const field of REASONING_FIELDS) {
    const text = extractReasoningText(delta[field]);
    if (text) {
      deltas.push({ field, text });
    }
  }

  return deltas;
}

function isChatReplayToolCall(value: unknown): value is ChatToolCall {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.type !== "function") return false;
  const fn = entry.function;
  if (!fn || typeof fn !== "object") return false;
  const f = fn as Record<string, unknown>;
  return typeof f.name === "string" && typeof f.arguments === "string";
}

function isChatReplayMessage(value: unknown): value is ChatMessage {
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

function assertChatReplayMessages(messages: unknown, field: string): asserts messages is ChatMessage[] {
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

function buildAssistantReplayMessage(params: {
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

// ── Adapter ───────────────────────────────────────────────────

export class ChatCompletionsAdapter extends HttpAdapterBase {
  readonly kind = "chat-completions" as const;
  readonly isSyntheticStream = false;

  constructor(options: ChatCompletionsAdapterOptions) {
    super(options, { baseUrl: "https://api.openai.com/v1" });
  }

  // ── buildRequest ──────────────────────────────────────────

  protected buildRequest(request: NormalizedRequest): ChatRequest {
    mapper.assertNoServerTools(request.serverTools);

    const messages: ChatMessage[] = [];

    // handle instructions → system message
    if (request.instructions) {
      messages.push({ role: "system", content: mapper.mapInstructions(request.instructions) });
    }

    for (const item of request.input) {
      switch (item.type) {
        case "message": {
          const role = item.role;
          const text = mapper.textFromBlocks(item.content, `input message (${item.role}) content`);
          messages.push({ role, content: text || null });
          break;
        }
        case "tool_call": {
          // 只允许附着到尾部 assistant turn，否则新建一个
          const lastAssistant =
            messages.length > 0 && messages[messages.length - 1]?.role === "assistant"
              ? messages[messages.length - 1]
              : null;
          const tc: ChatToolCall = {
            id: item.id,
            type: "function",
            function: { name: item.name, arguments: item.argumentsText },
          };
          if (lastAssistant) {
            lastAssistant.tool_calls = [...(lastAssistant.tool_calls ?? []), tc];
          } else {
            messages.push({ role: "assistant", content: null, tool_calls: [tc] });
          }
          break;
        }
        case "tool_result": {
          messages.push({
            role: "tool",
            tool_call_id: item.callId,
            name: item.toolName,
            content: mapper.textFromBlocks(item.content, `tool_result ${item.callId} content`),
          });
          break;
        }
        case "reasoning": {
          // chat.completions doesn't support reasoning items in input
          // Convert to a text message for best-effort
          messages.push({
            role: "assistant",
            content: mapper.textFromBlocks(item.content, "reasoning content"),
          });
          break;
        }
        case "opaque": {
          const payload = acceptOpaqueReplay(item, "chat.completions");
          if (!payload) break;
          if (payload.role === "assistant" && typeof payload.content === "string") {
            mapper.rollbackTrailingAssistantMessages(messages);
            messages.push({ role: "assistant", content: payload.content });
          } else if (payload.replaceCanonical === true && "messages" in payload) {
            assertChatReplayMessages(payload.messages, "messages");
            mapper.rollbackTrailingAssistantMessages(messages);
            for (const m of payload.messages) {
              messages.push(m);
            }
          } else if ("messages" in payload) {
            assertChatReplayMessages(payload.messages, "messages");
            mapper.rollbackTrailingAssistantMessages(messages);
            for (const m of payload.messages) {
              messages.push(m);
            }
          }
          break;
        }
      }
    }

    const body: ChatRequest = {
      model: request.model,
      messages,
      stream: true,
      n: 1,
    };

    body.tools = mapper.mapToolsIfPresent(
      request.tools,
      (t): ChatTool => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema as Record<string, unknown>,
        },
      }),
    );

    body.tool_choice = mapper.mapToolChoice<Exclude<ChatRequest["tool_choice"], undefined>>(request.toolChoice, {
      auto: "auto",
      none: "none",
      tool: (name) => ({ type: "function" as const, function: { name } }),
    });

    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
    if (request.metadata) body.metadata = request.metadata;
    if (request.reasoningLevel !== undefined) {
      body.reasoning_effort = mapChatCompletionsReasoningEffort(request.reasoningLevel);
    }

    return this.withExtraBody(body);
  }

  // ── runStream ─────────────────────────────────────────────

  protected async *runStream(
    providerRequest: ChatRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    const session = this.beginJsonStream(factory, request);
    const { auxiliary, gate } = session;
    const items = createStreamingItemSession(factory);

    await session.open({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.mergeHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      }),
      body: providerRequest,
    });

    const parser = createChatCompletionsSseParser<ChatChunk>();

    // wire 缓冲仅用于 opaque / finish 状态；item 内容账本由 items session 维护
    let responseId: string | undefined;
    let accumulatedContent = "";
    let currentMessageId = "";
    let currentReasoningId = "";
    let hasMessageStarted = false;
    let hasReasoningStarted = false;
    let warnedNonZeroChoice = false;

    // tool_calls 累积: tool call index → { id, name, args }
    const pendingToolCalls = new Map<number, PendingToolCall>();
    const reasoningByField = new Map<ReasoningFieldName, string>();

    const finalizePendingTurn = (): { events: AIStreamEvent[]; assistantReplayMessage: ChatMessage | null } => {
      const events: AIStreamEvent[] = [];
      const finalizedToolCalls = [...pendingToolCalls.values()];
      const finalizedReasoningByField = new Map(reasoningByField);

      if (hasReasoningStarted && items.isActive(currentReasoningId)) {
        events.push(items.completeReasoning(currentReasoningId));
      }

      if (hasMessageStarted && items.isActive(currentMessageId)) {
        events.push(items.completeMessage(currentMessageId));
      }

      for (const pending of finalizedToolCalls) {
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
      reasoningByField.clear();

      return { events, assistantReplayMessage };
    };

    const emitCompleted = async function* (
      stopReason: StopReason | undefined,
      assistantReplayMessage: ChatMessage | null,
      rawResponseId: string | undefined,
    ): AsyncIterable<AIStreamEvent> {
      const replay = [...replayFromOutput(items.completedItems())];
      if (assistantReplayMessage) {
        replay.push(
          opaqueItem("chat.completions", "replay", {
            replaceCanonical: true,
            messages: [assistantReplayMessage],
          }),
        );
      }

      yield* session.complete({
        replay,
        stopReason,
        rawResponseId,
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
            if (hasMessageStarted) return;
            currentMessageId = `msg-${chunk.id}`;
            hasMessageStarted = true;
            accumulatedContent = "";
            yield items.startMessage(currentMessageId);
          };

          if (reasoningDeltas.length > 0) {
            if (!hasReasoningStarted) {
              currentReasoningId = `reason-${chunk.id}`;
              hasReasoningStarted = true;
              yield items.startReasoning(currentReasoningId, "full");
            }

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

            for (const tc of delta.tool_calls) {
              const idx = tc.index;

              if (tc.id) {
                pendingToolCalls.set(idx, { id: tc.id, name: tc.function?.name ?? "", args: "" });
                yield items.startToolCall(tc.id, tc.function?.name ?? "");
              }

              if (tc.function?.arguments) {
                const pending = pendingToolCalls.get(idx);
                if (pending) {
                  pending.args += tc.function.arguments;
                  yield items.deltaToolCall(pending.id, { argumentsText: tc.function.arguments });
                }
              }
            }
          }

          if (delta.function_call) {
            yield* ensureMessageStarted();

            if (delta.function_call.name) {
              const fcId = `fc-${chunk.id}-0`;
              pendingToolCalls.set(0, { id: fcId, name: delta.function_call.name, args: "" });
              yield items.startToolCall(fcId, delta.function_call.name);
            }
            if (delta.function_call.arguments) {
              const pending = pendingToolCalls.get(0);
              if (pending) {
                pending.args += delta.function_call.arguments;
                yield items.deltaToolCall(pending.id, { argumentsText: delta.function_call.arguments });
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

    if (!gate.completed && (hasMessageStarted || hasReasoningStarted || pendingToolCalls.size > 0)) {
      yield factory.responseWarning("Stream ended without a finish_reason", WarningCode.STREAM_INCOMPLETE);
      const { events, assistantReplayMessage } = finalizePendingTurn();
      for (const event of events) yield event;
      yield* emitCompleted(undefined, assistantReplayMessage, responseId);
    }
  }
}
