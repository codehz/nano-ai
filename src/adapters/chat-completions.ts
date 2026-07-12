/**
 * Chat Completions Adapter
 *
 * 接入 OpenAI Chat Completions API (chat/completions 端点)。
 * 弱能力兼容层：
 * - third-party reasoning 字段仅做 best-effort 提取
 * - 工具调用通常整块到达（非逐 token 流）
 * - replay fidelity 依赖 provider 是否暴露可回放的 assistant turn 字段
 */

import { AdapterBase } from "../helpers/adapter-base.js";
import { AIProviderError, AIRequestError, AIStreamError } from "../core/errors.js";
import {
  textBlock,
  messageItem,
  reasoningItem,
  toolCallItem,
  opaqueItem,
  replayFromOutput,
  mapStopReason,
  contentBlocksToText,
} from "../helpers/mapping.js";
import { emitMalformedStreamWarning } from "../helpers/adapter-auxiliary.js";
import { assertOpaqueReplayEnvelope, providerHttpError } from "../helpers/adapter-security.js";
import { usageFromChatCompletions } from "../helpers/usage-mapping.js";
import { NormalizedRequestMapper, splitLines, IncrementalStreamParser } from "../helpers/index.js";
import type { ProviderProfile } from "../helpers/index.js";

import type { NormalizedRequest, AIStreamEvent, EventFactory, OutputItem, FetchFn } from "../index.js";

// ── 类型 ──────────────────────────────────────────────────────

export type ChatCompletionsAdapterOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchFn;
};

// ── Chat API 请求类型 ─────────────────────────────────────────

type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  metadata?: Record<string, string>;
  temperature?: number;
  max_tokens?: number;
  stream: true;
  n: 1;
};

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
  [key: string]: unknown;
};

type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatTool = {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
};

// ── SSE chunk 类型 ────────────────────────────────────────────

type ChatChunk = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChunkChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
};

type ChatChunkChoice = {
  index: number;
  delta: {
    role?: string;
    content?: string | null;
    reasoning?: unknown;
    reasoning_content?: unknown;
    tool_calls?: ChatChunkToolCall[];
    function_call?: { name?: string; arguments?: string };
    [key: string]: unknown;
  };
  finish_reason?: string | null;
};

type ChatChunkToolCall = {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type PendingToolCall = {
  id: string;
  name: string;
  args: string;
};

type ReasoningFieldName = "reasoning" | "reasoning_content";

const REASONING_FIELDS: readonly ReasoningFieldName[] = ["reasoning_content", "reasoning"];

// ── ProviderProfile & Mapper ────────────────────────────────────

const profile: ProviderProfile = {
  kind: "chat-completions",
  instructionsMode: "system_message",
  supportedBlockTypes: ["text", "json"] as const,
  reasoningBlockTypes: ["text"] as const,
  capabilities: {
    textStreaming: "native",
    reasoningStreaming: "native",
    toolCallStreaming: "native",
    replay: "opaque",
    usage: "final",
    toolResultOutcomes: ["success"],
  },
};

const mapper = new NormalizedRequestMapper(profile);

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

export class ChatCompletionsAdapter extends AdapterBase {
  readonly kind = "chat-completions" as const;
  readonly capabilities = profile.capabilities;

  private apiKey: string;
  private baseUrl: string;
  private fetchFn: FetchFn;

  constructor(options: ChatCompletionsAdapterOptions) {
    super();
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  // ── buildRequest ──────────────────────────────────────────

  protected buildRequest(request: NormalizedRequest): ChatRequest {
    const messages: ChatMessage[] = [];

    // handle instructions → system message
    if (request.instructions) {
      messages.push({ role: "system", content: mapper.mapInstructions(request.instructions) });
    }

    for (const item of request.input) {
      switch (item.type) {
        case "message": {
          const role = item.role;
          const text = contentBlocksToText(
            mapper.ensureTextBlocks(item.content, `input message (${item.role}) content`),
          );
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
          mapper.assertToolResultOutcome(item.outcome);
          messages.push({
            role: "tool",
            tool_call_id: item.callId,
            name: item.toolName,
            content: contentBlocksToText(mapper.ensureTextBlocks(item.content, `tool_result ${item.callId} content`)),
          });
          break;
        }
        case "reasoning": {
          // chat.completions doesn't support reasoning items in input
          // Convert to a text message for best-effort
          messages.push({
            role: "assistant",
            content: contentBlocksToText(mapper.ensureTextBlocks(item.content, "reasoning content")),
          });
          break;
        }
        case "opaque": {
          // Try to restore from opaque replay
          if (item.purpose !== "replay") break;
          assertOpaqueReplayEnvelope(item.payload);
          const payload = item.payload as Record<string, unknown>;
          if (payload.role === "assistant" && typeof payload.content === "string") {
            messages.push({ role: "assistant", content: payload.content });
          } else if (payload.replaceCanonical === true && "messages" in payload) {
            assertChatReplayMessages(payload.messages, "messages");
            mapper.rollbackTrailingAssistantMessages(messages);
            for (const m of payload.messages) {
              messages.push(m);
            }
          } else if ("messages" in payload) {
            assertChatReplayMessages(payload.messages, "messages");
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

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(
        (t): ChatTool => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema as Record<string, unknown>,
          },
        }),
      );
    }

    if (request.toolChoice) {
      if (request.toolChoice === "auto") body.tool_choice = "auto";
      else if (request.toolChoice === "none") body.tool_choice = "none";
      else if (request.toolChoice.type === "tool") {
        body.tool_choice = { type: "function", function: { name: request.toolChoice.name } };
      }
    }

    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
    if (request.metadata) body.metadata = request.metadata;

    return body;
  }

  // ── runStream ─────────────────────────────────────────────

  protected async *runStream(
    providerRequest: ChatRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    const auxiliary = this.createAuxiliaryState(request);
    let response: Response;

    try {
      response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(providerRequest),
      });
    } catch (err) {
      throw new AIProviderError(err instanceof Error ? err.message : String(err), "PROVIDER_ERROR");
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw providerHttpError(response.status, errorBody);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new AIStreamError("Response body is not readable", "STREAM_ERROR");
    }

    const parser = new IncrementalStreamParser<ChatChunk>(splitLines, (item: string) => {
      const trimmed = item.trim();
      if (!trimmed.startsWith("data: ")) return { status: "ignored" };
      const data = trimmed.slice(6).trim();
      if (data === "[DONE]") return { status: "ignored" };
      try {
        return { status: "parsed", value: JSON.parse(data) as ChatChunk };
      } catch {
        return { status: "malformed" };
      }
    });

    const output: OutputItem[] = [];
    let streamDone = false;

    // 累积状态 — 支持多 choice，此处只取 index 0
    let responseId: string | undefined;
    let accumulatedContent = "";
    let accumulatedReasoning = "";
    let currentMessageId = "";
    let currentReasoningId = "";
    let hasMessageStarted = false;
    let hasReasoningStarted = false;
    let completedEmitted = false;
    let warnedNonZeroChoice = false;
    const buildResponse = this.buildResponse.bind(this);

    // tool_calls 累积: tool call index → { id, name, args }
    const pendingToolCalls = new Map<number, PendingToolCall>();
    const reasoningByField = new Map<ReasoningFieldName, string>();

    const finalizePendingTurn = (): { events: AIStreamEvent[]; assistantReplayMessage: ChatMessage | null } => {
      const events: AIStreamEvent[] = [];
      const finalizedToolCalls = [...pendingToolCalls.values()];
      const finalizedReasoningByField = new Map(reasoningByField);

      if (hasReasoningStarted && accumulatedReasoning) {
        const reasoning = reasoningItem([textBlock(accumulatedReasoning)], "full", currentReasoningId);
        events.push(factory.reasoningCompleted(currentReasoningId));
        output.push(reasoning);
      }

      if (hasMessageStarted) {
        const message = messageItem([textBlock(accumulatedContent)], { id: currentMessageId });
        events.push(factory.messageCompleted(currentMessageId));
        if (accumulatedContent) {
          output.push(message);
        }
      }

      for (const pending of finalizedToolCalls) {
        const toolCall = toolCallItem(pending.id, pending.name, pending.args);
        events.push(factory.toolCallCompleted(pending.id));
        output.push(toolCall);
      }

      const assistantReplayMessage = buildAssistantReplayMessage({
        content: accumulatedContent,
        reasoningByField: finalizedReasoningByField,
        toolCalls: finalizedToolCalls,
      });

      accumulatedContent = "";
      accumulatedReasoning = "";
      currentMessageId = "";
      currentReasoningId = "";
      hasMessageStarted = false;
      hasReasoningStarted = false;
      pendingToolCalls.clear();
      reasoningByField.clear();

      return { events, assistantReplayMessage };
    };

    const emitCompleted = async function* (
      stopReason: import("../index.js").StopReason | undefined,
      assistantReplayMessage: ChatMessage | null,
      rawResponseId: string | undefined,
    ): AsyncIterable<AIStreamEvent> {
      if (completedEmitted) {
        yield factory.responseWarning("Duplicate finish signal ignored", "DUPLICATE_FINISH");
        return;
      }

      completedEmitted = true;

      const replay = [...replayFromOutput(output)];

      if (assistantReplayMessage) {
        replay.push(
          opaqueItem("chat.completions", "replay", {
            replaceCanonical: true,
            messages: [assistantReplayMessage],
          }),
        );
      }

      const auxiliaryResult = await auxiliary.finalize(factory);
      for (const event of auxiliaryResult.events) {
        yield event;
      }

      const finalResponse = buildResponse(
        request,
        {
          output,
          replay,
          stopReason,
          usage: auxiliaryResult.usage,
          billing: auxiliaryResult.billing,
          auxiliary: auxiliaryResult.auxiliary,
          warnings: auxiliaryResult.warnings,
          metadataSources: auxiliaryResult.metadataSources,
          rawResponseId,
        },
        factory,
      );
      yield factory.responseCompleted({
        replay: finalResponse.replay,
        stopReason: finalResponse.stopReason,
        trace: finalResponse.backend,
        usage: finalResponse.usage,
        billing: finalResponse.billing,
        auxiliary: finalResponse.auxiliary,
        warnings: finalResponse.warnings,
      });
    };

    try {
      while (true) {
        const readResult = await reader.read().catch((err: unknown) => {
          throw new AIStreamError(
            `Failed to read response stream: ${err instanceof Error ? err.message : String(err)}`,
            "STREAM_ERROR",
          );
        });
        const { done, value } = readResult;
        const { items: chunks, malformed: malformedEvents } = done ? parser.flush() : parser.feed(value as Uint8Array);

        const malformedWarning = emitMalformedStreamWarning(factory, {
          count: malformedEvents,
          providerLabel: "Chat Completions",
          transportLabel: "SSE event(s)",
        });
        if (malformedWarning) {
          yield malformedWarning;
        }

        for (const chunk of chunks) {
          responseId = chunk.id;

          // usage 可能在最终 chunk 中
          if (chunk.usage) {
            auxiliary.recordUsage(usageFromChatCompletions(chunk.usage), "final", chunk.usage);
          }

          for (const choice of chunk.choices) {
            if (choice.index !== 0) {
              if (!warnedNonZeroChoice) {
                yield factory.responseWarning(
                  `Chat Completions returned choice index ${choice.index}; only the first choice (index 0) is supported. This choice is ignored.`,
                  "MULTIPLE_CHOICES_IGNORED",
                );
                warnedNonZeroChoice = true;
              }
              continue;
            }

            if (completedEmitted) {
              if (choice.finish_reason) {
                yield factory.responseWarning("Duplicate finish signal ignored", "DUPLICATE_FINISH");
              }
              continue;
            }

            const delta = choice.delta;
            const finishReason = choice.finish_reason;
            const reasoningDeltas = extractReasoningDeltas(delta);

            const ensureMessageStarted = (): void => {
              if (hasMessageStarted) return;
              currentMessageId = `msg-${chunk.id}`;
              hasMessageStarted = true;
              accumulatedContent = "";
            };

            // 处理 role: assistant（首块标识；不要求 content）
            if (delta.role === "assistant" && !hasMessageStarted) {
              ensureMessageStarted();
              yield factory.messageStarted(currentMessageId);
            }

            // 处理 third-party reasoning delta
            if (reasoningDeltas.length > 0) {
              if (!hasReasoningStarted) {
                currentReasoningId = `reason-${chunk.id}`;
                hasReasoningStarted = true;
                accumulatedReasoning = "";
                yield factory.reasoningStarted(currentReasoningId, "full");
              }

              for (const reasoningDelta of reasoningDeltas) {
                accumulatedReasoning += reasoningDelta.text;
                reasoningByField.set(
                  reasoningDelta.field,
                  (reasoningByField.get(reasoningDelta.field) ?? "") + reasoningDelta.text,
                );
                yield factory.reasoningDelta(currentReasoningId, textBlock(reasoningDelta.text));
              }
            }

            // 处理 content delta
            if (delta.content) {
              if (!hasMessageStarted) {
                ensureMessageStarted();
                yield factory.messageStarted(currentMessageId);
              }
              accumulatedContent += delta.content;
              yield factory.messageDelta(currentMessageId, textBlock(delta.content));
            }

            // 处理 tool_calls delta
            if (delta.tool_calls) {
              if (!hasMessageStarted) {
                ensureMessageStarted();
                yield factory.messageStarted(currentMessageId);
              }

              for (const tc of delta.tool_calls) {
                const idx = tc.index;

                if (tc.id) {
                  pendingToolCalls.set(idx, { id: tc.id, name: tc.function?.name ?? "", args: "" });
                  yield factory.toolCallStarted(tc.id, tc.function?.name ?? "");
                }

                if (tc.function?.arguments) {
                  const pending = pendingToolCalls.get(idx);
                  if (pending) {
                    pending.args += tc.function.arguments;
                    yield factory.toolCallDelta(pending.id, { argumentsText: tc.function.arguments });
                  }
                }
              }
            }

            // 处理 function_call delta (legacy format)
            if (delta.function_call) {
              if (!hasMessageStarted) {
                ensureMessageStarted();
                yield factory.messageStarted(currentMessageId);
              }

              if (delta.function_call.name) {
                const fcId = `fc-${chunk.id}-0`;
                pendingToolCalls.set(0, { id: fcId, name: delta.function_call.name, args: "" });
                yield factory.toolCallStarted(fcId, delta.function_call.name);
              }
              if (delta.function_call.arguments) {
                const pending = pendingToolCalls.get(0);
                if (pending) {
                  pending.args += delta.function_call.arguments;
                  yield factory.toolCallDelta(pending.id, { argumentsText: delta.function_call.arguments });
                }
              }
            }

            // 处理 finish_reason
            if (finishReason && finishReason !== null) {
              const { events, assistantReplayMessage } = finalizePendingTurn();
              for (const event of events) {
                yield event;
              }

              const stopReason = mapStopReason(finishReason);
              yield* emitCompleted(stopReason, assistantReplayMessage, chunk.id);
            }
          }
        }

        if (done) {
          streamDone = true;
          break;
        }
      }
    } finally {
      try {
        if (!streamDone) await reader.cancel().catch(() => undefined);
      } finally {
        reader.releaseLock();
      }
    }

    if (parser.getRemaining().trim().length > 0) {
      yield factory.responseWarning("Stream ended with an incomplete Chat Completions SSE frame", "STREAM_ERROR");
    }

    // 如果流结束时没有 finish_reason（断流），也尝试关闭
    if (!completedEmitted && (hasMessageStarted || hasReasoningStarted || pendingToolCalls.size > 0)) {
      yield factory.responseWarning("Stream ended without a finish_reason", "INCOMPLETE_STREAM");

      const { events, assistantReplayMessage } = finalizePendingTurn();
      for (const event of events) {
        yield event;
      }

      yield* emitCompleted(undefined, assistantReplayMessage, responseId);
    }
  }
}
