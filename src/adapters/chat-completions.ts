/**
 * Chat Completions Adapter
 *
 * 接入 OpenAI Chat Completions API (chat/completions 端点)。
 * 弱能力兼容层：
 * - 无 reasoning 流
 * - 工具调用通常整块到达（非逐 token 流）
 * - replay fidelity 较低
 */

import { AdapterBase } from "../helpers/adapter-base.js";
import {
  textBlock,
  messageItem,
  toolCallItem,
  opaqueItem,
  replayFromOutput,
  mapStopReason,
} from "../helpers/mapping.js";

import type { NormalizedRequest, AIStreamEvent, EventFactory, OutputItem, Usage } from "../index.js";

// ── 类型 ──────────────────────────────────────────────────────

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

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
    content?: string;
    tool_calls?: ChatChunkToolCall[];
    function_call?: { name?: string; arguments?: string };
  };
  finish_reason?: string | null;
};

type ChatChunkToolCall = {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

// ── SSE 解析 ──────────────────────────────────────────────────

function parseChatSSE(buffer: string): { chunks: ChatChunk[]; rest: string } {
  const chunks: ChatChunk[] = [];
  let rest = buffer;

  while (true) {
    const lineEnd = rest.indexOf("\n");
    if (lineEnd === -1) break;

    const line = rest.slice(0, lineEnd).trim();
    rest = rest.slice(lineEnd + 1);

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

// ── Adapter ───────────────────────────────────────────────────

export class ChatCompletionsAdapter extends AdapterBase {
  readonly kind = "chat-completions" as const;
  readonly capabilities = {
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
      const text =
        typeof request.instructions === "string"
          ? request.instructions
          : request.instructions.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      messages.push({ role: "system", content: text });
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
          const content = item.content
            .map((b) => (b.type === "text" ? b.text : b.type === "json" ? JSON.stringify(b.json) : ""))
            .join("\n");
          messages.push({ role, content: content || null });
          break;
        }
        case "tool_call": {
          // Find last assistant message and add tool_call, or create new one
          const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
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
          const text = item.content
            .map((b) => {
              if (b.type === "text") return b.text;
              if (b.type === "json") return JSON.stringify(b.json);
              return "";
            })
            .join("\n");
          messages.push({
            role: "tool",
            tool_call_id: item.callId,
            name: item.toolName,
            content: text,
          });
          break;
        }
        case "reasoning": {
          // chat.completions doesn't support reasoning items in input
          // Convert to a text message for best-effort
          const text = item.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
          messages.push({ role: "assistant", content: text });
          break;
        }
        case "opaque": {
          // Try to restore from opaque replay
          if (item.purpose === "replay" && typeof item.payload === "object" && item.payload !== null) {
            const payload = item.payload as Record<string, unknown>;
            if (payload.role === "assistant" && typeof payload.content === "string") {
              messages.push({ role: "assistant", content: payload.content as string });
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
    let currentMessageId = "";
    let hasMessageStarted = false;

    // tool_calls 累积: tool call index → { id, name, args }
    const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();

    // usage
    let usage: Usage | undefined;

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

            // 处理 role: assistant (首块标识)
            if (delta.role === "assistant" && delta.content !== undefined && !hasMessageStarted) {
              currentMessageId = `msg-${chunk.id}`;
              hasMessageStarted = true;
              accumulatedContent = "";
              yield factory.messageStarted(currentMessageId);
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
              // 关闭还未 close 的消息
              if (hasMessageStarted && accumulatedContent) {
                yield factory.messageCompleted(messageItem([textBlock(accumulatedContent)], { id: currentMessageId }));
                output.push(messageItem([textBlock(accumulatedContent)], { id: currentMessageId }));
                hasMessageStarted = false;
              }

              // 关闭未 close 的 tool calls
              for (const [, pending] of pendingToolCalls) {
                const tcItem = toolCallItem(pending.id, pending.name, pending.args);
                yield factory.toolCallCompleted(tcItem);
                output.push(tcItem);
              }
              pendingToolCalls.clear();

              // 构建 stop reason
              const stopReason = mapStopReason(finishReason);

              // 构建 replay
              const replay = [...replayFromOutput(output)];

              // 附加 opaque replay
              replay.push(
                opaqueItem("chat.completions", "replay", {
                  role: "assistant",
                  content: accumulatedContent,
                }),
              );

              yield factory.responseCompleted(
                this.buildResponse(request, { output, replay, stopReason, usage, rawResponseId: chunk.id }, factory),
              );

              hasMessageStarted = false;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 如果流结束时没有 finish_reason（断流），也尝试关闭
    if (hasMessageStarted || pendingToolCalls.size > 0) {
      yield factory.responseWarning("Stream ended without a finish_reason", "INCOMPLETE_STREAM");

      if (hasMessageStarted && accumulatedContent) {
        yield factory.messageCompleted(messageItem([textBlock(accumulatedContent)], { id: currentMessageId }));
        output.push(messageItem([textBlock(accumulatedContent)], { id: currentMessageId }));
      }
      for (const [, pending] of pendingToolCalls) {
        const tcItem = toolCallItem(pending.id, pending.name, pending.args);
        yield factory.toolCallCompleted(tcItem);
        output.push(tcItem);
      }

      yield factory.responseCompleted(
        this.buildResponse(request, { output, replay: replayFromOutput(output), rawResponseId: responseId }, factory),
      );
    }
  }
}
