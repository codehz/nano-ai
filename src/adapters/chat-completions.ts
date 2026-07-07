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
import {
  textBlock,
  messageItem,
  reasoningItem,
  toolCallItem,
  opaqueItem,
  replayFromOutput,
  mapStopReason,
  instructionsToText,
  contentBlocksToText,
} from "../helpers/mapping.js";

import type { AdapterCapabilities, NormalizedRequest, AIStreamEvent, EventFactory, OutputItem, Usage, FetchFn } from "../index.js";

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
  temperature?: number;
  max_tokens?: number;
  stream: true;
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
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
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

// ── SSE 解析 ──────────────────────────────────────────────────

function parseChatSSE(buffer: string): { chunks: ChatChunk[]; rest: string } {
  const chunks: ChatChunk[] = [];
  let rest = buffer;
  let lastProcessedIndex = 0;

  while (true) {
    const lineEnd = rest.indexOf("\n");
    if (lineEnd === -1) {
      // 没有更多完整行，剩余部分保留到下次
      break;
    }

    const line = rest.slice(0, lineEnd).trim();
    rest = rest.slice(lineEnd + 1);
    lastProcessedIndex += lineEnd + 1;

    if (!line.startsWith("data: ")) continue;

    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;

    try {
      chunks.push(JSON.parse(data));
    } catch {
      // skip malformed
    }
  }

  return { chunks, rest };
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
  readonly capabilities: AdapterCapabilities = {
    nativeStreaming: true,
    messageStreaming: true,
    reasoningStreaming: false,
    toolCallStreaming: false,
    hiddenReasoningReplay: "none" as const,
    replayFidelity: "low" as const,
    tools: true,
    usage: "full" as const,
    billing: "derived" as const,
    providerMetadata: false,
  };

  private apiKey: string;
  private baseUrl: string;
  private fetchFn: FetchFn;

  private markReasoningCompatibility(): void {
    this.capabilities.reasoningStreaming = true;
    this.capabilities.hiddenReasoningReplay = "partial";
    this.capabilities.replayFidelity = "medium";
  }

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
      messages.push({ role: "system", content: instructionsToText(request.instructions) });
    }

    for (const item of request.input) {
      switch (item.type) {
        case "message": {
          const role =
            item.role === "developer"
              ? "system"
              : item.role === "system"
                ? "system"
                : item.role === "user"
                  ? "user"
                  : "assistant";
          const text = contentBlocksToText(item.content);
          messages.push({ role, content: text || null });
          break;
        }
        case "tool_call": {
          // Find last assistant message and add tool_call, or create new one
          const lastAssistant = messages.findLast((m) => m.role === "assistant");
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
            content: contentBlocksToText(item.content),
          });
          break;
        }
        case "reasoning": {
          // chat.completions doesn't support reasoning items in input
          // Convert to a text message for best-effort
          messages.push({ role: "assistant", content: contentBlocksToText(item.content) });
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

    return body;
  }

  // ── runStream ─────────────────────────────────────────────

  protected async *runStream(
    providerRequest: ChatRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(providerRequest),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`Chat Completions API error ${response.status}: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Response body is not readable");
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
    let hasStreamedReasoning = false;

    // tool_calls 累积: tool call index → { id, name, args }
    const pendingToolCalls = new Map<number, PendingToolCall>();
    const reasoningByField = new Map<ReasoningFieldName, string>();

    // usage
    let usage: Usage | undefined;

    const finalizePendingTurn = (): { events: AIStreamEvent[]; assistantReplayMessage: ChatMessage | null } => {
      const events: AIStreamEvent[] = [];
      const finalizedToolCalls = [...pendingToolCalls.values()];
      const finalizedReasoningByField = new Map(reasoningByField);

      if (hasReasoningStarted && accumulatedReasoning) {
        const reasoning = reasoningItem([textBlock(accumulatedReasoning)], "full", currentReasoningId);
        events.push(factory.reasoningCompleted(reasoning));
        output.push(reasoning);
      }

      if (hasMessageStarted && accumulatedContent) {
        const message = messageItem([textBlock(accumulatedContent)], { id: currentMessageId });
        events.push(factory.messageCompleted(message));
        output.push(message);
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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { chunks, rest } = parseChatSSE(buffer);
        buffer = rest;

        for (const chunk of chunks) {
          responseId = chunk.id;

          // usage 可能在最终 chunk 中
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            };
          }

          for (const choice of chunk.choices) {
            const delta = choice.delta;
            const finishReason = choice.finish_reason;
            const reasoningDeltas = extractReasoningDeltas(delta);

            // 处理 role: assistant (首块标识)
            if (delta.role === "assistant" && typeof delta.content === "string" && !hasMessageStarted) {
              currentMessageId = `msg-${chunk.id}`;
              hasMessageStarted = true;
              accumulatedContent = "";
              yield factory.messageStarted(currentMessageId);
            }

            // 处理 third-party reasoning delta
            if (reasoningDeltas.length > 0) {
              if (!hasReasoningStarted) {
                currentReasoningId = `reason-${chunk.id}`;
                hasReasoningStarted = true;
                hasStreamedReasoning = true;
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
                currentMessageId = `msg-${chunk.id}`;
                hasMessageStarted = true;
                yield factory.messageStarted(currentMessageId);
              }
              accumulatedContent += delta.content;
              yield factory.messageDelta(currentMessageId, delta.content);
            }

            // 处理 tool_calls delta
            if (delta.tool_calls) {
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

              if (hasStreamedReasoning) this.markReasoningCompatibility();

              // 构建 stop reason
              const stopReason = mapStopReason(finishReason);

              // 构建 replay
              const replay = [...replayFromOutput(output)];

              // 附加 opaque replay
              if (assistantReplayMessage) {
                replay.push(
                  opaqueItem("chat.completions", "replay", {
                    replaceCanonical: true,
                    messages: [assistantReplayMessage],
                  }),
                );
              }

              yield factory.responseCompleted(
                this.buildResponse(request, { output, replay, stopReason, usage, rawResponseId: chunk.id }, factory),
              );
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 如果流结束时没有 finish_reason（断流），也尝试关闭
    if (hasMessageStarted || hasReasoningStarted || pendingToolCalls.size > 0) {
      yield factory.responseWarning("Stream ended without a finish_reason", "INCOMPLETE_STREAM");

      if (hasStreamedReasoning) this.markReasoningCompatibility();

      const { events, assistantReplayMessage } = finalizePendingTurn();
      for (const event of events) {
        yield event;
      }

      const replay = [...replayFromOutput(output)];
      if (assistantReplayMessage) {
        replay.push(
          opaqueItem("chat.completions", "replay", {
            replaceCanonical: true,
            messages: [assistantReplayMessage],
          }),
        );
      }

      yield factory.responseCompleted(
        this.buildResponse(request, { output, replay, rawResponseId: responseId }, factory),
      );
    }
  }
}
