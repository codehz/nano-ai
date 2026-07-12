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
import { usageFromChatCompletions } from "../helpers/usage-mapping.js";

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

function assertChatToolResultOutcome(outcome: import("../index.js").ToolResultItem["outcome"]): void {
  if (outcome !== "success") {
    throw new AIRequestError(
      `chat-completions does not preserve tool_result outcome "${outcome}"; only "success" is supported`,
      "UNSUPPORTED_TOOL_RESULT_OUTCOME",
    );
  }
}

// ── SSE 解析 ──────────────────────────────────────────────────

/**
 * Chat Completions 的简化 SSE 解析器。
 *
 * 约束：
 * - 每条 `data:` 行必须已经是一个完整 JSON 对象
 * - 允许传输层把单行拆成多个 chunk，但不接受 provider 把一个 JSON event 改写成多条 `data:` 行
 */
function parseChatSSE(buffer: string, allowEOF = false): { chunks: ChatChunk[]; rest: string; malformedEvents: number } {
  const chunks: ChatChunk[] = [];
  let rest = buffer;
  let malformedEvents = 0;

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.trim();

    if (!line.startsWith("data: ")) return;

    const data = line.slice(6).trim();
    if (data === "[DONE]") return;

    try {
      chunks.push(JSON.parse(data));
    } catch {
      malformedEvents++;
    }
  };

  while (true) {
    const lineEnd = rest.indexOf("\n");
    if (lineEnd === -1) {
      if (allowEOF && rest.length > 0) {
        consumeLine(rest);
        rest = "";
      }
      break;
    }

    const line = rest.slice(0, lineEnd);
    rest = rest.slice(lineEnd + 1);

    consumeLine(line);
  }

  return { chunks, rest, malformedEvents };
}

function ensureTextCompatibleBlocks(
  blocks: import("../index.js").ContentBlock[],
  field: string,
): import("../index.js").ContentBlock[] {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;
    if (block.type !== "text" && block.type !== "json") {
      throw new AIRequestError(
        `chat-completions does not support ${field}[${i}] of type "${block.type}"; only text/json blocks are supported`,
        "UNSUPPORTED_CONTENT_BLOCK",
      );
    }
  }

  return blocks;
}

function contentBlocksToChatText(blocks: import("../index.js").ContentBlock[], field: string): string {
  return contentBlocksToText(ensureTextCompatibleBlocks(blocks, field));
}

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

function rollbackTrailingAssistantMessages(messages: ChatMessage[]): void {
  while (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
    messages.pop();
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
  readonly nativeStreaming = true;

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
      const content =
        typeof request.instructions === "string"
          ? request.instructions
          : contentBlocksToChatText(request.instructions, "instructions");
      messages.push({ role: "system", content });
    }

    for (const item of request.input) {
      switch (item.type) {
        case "message": {
          const role = item.role;
          const text = contentBlocksToChatText(item.content, `input message (${item.role}) content`);
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
          assertChatToolResultOutcome(item.outcome);
          messages.push({
            role: "tool",
            tool_call_id: item.callId,
            name: item.toolName,
            content: contentBlocksToChatText(item.content, `tool_result ${item.callId} content`),
          });
          break;
        }
        case "reasoning": {
          // chat.completions doesn't support reasoning items in input
          // Convert to a text message for best-effort
          messages.push({
            role: "assistant",
            content: contentBlocksToChatText(item.content, "reasoning content"),
          });
          break;
        }
        case "opaque": {
          // Try to restore from opaque replay
          if (item.purpose === "replay" && typeof item.payload === "object" && item.payload !== null) {
            const payload = item.payload as Record<string, unknown>;
            if (payload.role === "assistant" && typeof payload.content === "string") {
              messages.push({ role: "assistant", content: payload.content as string });
            } else if (payload.replaceCanonical === true && Array.isArray(payload.messages)) {
              rollbackTrailingAssistantMessages(messages);
              for (const m of payload.messages as ChatMessage[]) {
                messages.push(m);
              }
            } else if (Array.isArray(payload.messages)) {
              for (const m of payload.messages as ChatMessage[]) {
                messages.push(m);
              }
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
      const errorText = await response.text().catch(() => "unknown error");
      throw new AIProviderError(
        `Chat Completions API error ${response.status}: ${errorText}`,
        "PROVIDER_ERROR",
        response.status,
        errorText,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new AIStreamError("Response body is not readable", "STREAM_ERROR");
    }

    const output: OutputItem[] = [];
    const decoder = new TextDecoder();
    let buffer = "";

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
        events.push(factory.reasoningCompleted(reasoning));
        output.push(reasoning);
      }

      if (hasMessageStarted) {
        const message = messageItem([textBlock(accumulatedContent)], { id: currentMessageId });
        events.push(factory.messageCompleted(message));
        if (accumulatedContent) {
          output.push(message);
        }
      }

      for (const pending of finalizedToolCalls) {
        const toolCall = toolCallItem(pending.id, pending.name, pending.args);
        events.push(factory.toolCallCompleted(toolCall));
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

      yield factory.responseCompleted(
        buildResponse(
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
        ),
      );
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const { chunks, rest, malformedEvents } = parseChatSSE(buffer, done);
        buffer = rest;

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
              yield factory.messageDelta(currentMessageId, delta.content);
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

        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }

    if (buffer.trim().length > 0) {
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
