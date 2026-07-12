/**
 * Ollama Adapter
 *
 * 接入 Ollama 原生 Chat API (/api/chat)。
 * 与 Chat Completions 兼容层不同，此处直接使用 Ollama 的 NDJSON 流格式。
 *
 * 能力:
 * - 消息流（完整 content 逐块到达）
 * - 工具调用（整块到达，非逐 token）
 * - 用量信息（仅 prompt_eval_count / eval_count）
 *
 * 限制：
 * - 不流式输出 reasoning（Ollama 原生 API 无独立思考字段）
 * - tool_call 不支持逐 token 流式
 * - replay 保真度低（无 opaque continuation 机制）
 */

import { AdapterBase } from "../helpers/adapter-base.js";
import { AIRequestError } from "../core/errors.js";
import {
  textBlock,
  messageItem,
  toolCallItem,
  opaqueItem,
  replayFromOutput,
  mapStopReason,
  contentBlocksToText,
} from "../helpers/mapping.js";
import { emitMalformedStreamWarning } from "../helpers/adapter-auxiliary.js";
import { usageFromOllama } from "../helpers/usage-mapping.js";

import type { NormalizedRequest, AIStreamEvent, EventFactory, OutputItem, FetchFn } from "../index.js";

// ── 选项类型 ──────────────────────────────────────────────────

export type OllamaAdapterOptions = {
  /** Ollama 服务地址，默认 http://localhost:11434 */
  baseUrl?: string;
  /** 可选 API key（用于需要认证的代理场景） */
  apiKey?: string;
  /** 可注入自定义 fetch 实现 */
  fetch?: FetchFn;
};

// ── Ollama Chat API 类型 ──────────────────────────────────────

type OllamaChatRequest = {
  model: string;
  messages: OllamaMessage[];
  stream: true;
  tools?: OllamaTool[];
  options?: {
    temperature?: number;
    num_predict?: number;
    [key: string]: unknown;
  };
};

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
};

type OllamaToolCall = {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
};

type OllamaTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

function ensureOllamaTextBlocks(
  blocks: import("../index.js").ContentBlock[],
  field: string,
): import("../index.js").ContentBlock[] {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;
    if (block.type !== "text" && block.type !== "json") {
      throw new AIRequestError(
        `ollama does not support ${field}[${i}] of type "${block.type}"; only text/json blocks are supported`,
        "UNSUPPORTED_CONTENT_BLOCK",
      );
    }
  }

  return blocks;
}

function ensureOllamaReasoningBlocks(
  blocks: import("../index.js").ContentBlock[],
  field: string,
): Array<Extract<import("../index.js").ContentBlock, { type: "text" }>> {
  return blocks.map((block, index) => {
    if (block.type !== "text") {
      throw new AIRequestError(
        `ollama does not support ${field}[${index}] of type "${block.type}"; reasoning only supports text blocks`,
        "UNSUPPORTED_CONTENT_BLOCK",
      );
    }

    return block;
  });
}

function instructionsToOllamaText(instructions: string | import("../index.js").InstructionBlock[]): string {
  return typeof instructions === "string"
    ? instructions
    : contentBlocksToText(ensureOllamaTextBlocks(instructions, "instructions"));
}

function parseOllamaToolArguments(item: import("../index.js").ToolCallItem): Record<string, unknown> {
  if (item.argumentsJson && typeof item.argumentsJson === "object" && item.argumentsJson !== null) {
    return item.argumentsJson as Record<string, unknown>;
  }

  try {
    const parsed = JSON.parse(item.argumentsText);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }

  throw new AIRequestError(
    "ollama tool_call argumentsText must be valid JSON object when argumentsJson is absent",
    "TOOL_CALL_ARGUMENTS_INVALID",
  );
}

function assertOllamaToolResultOutcome(outcome: import("../index.js").ToolResultItem["outcome"]): void {
  if (outcome !== "success") {
    throw new AIRequestError(
      `ollama does not preserve tool_result outcome "${outcome}"; only "success" is supported`,
      "UNSUPPORTED_TOOL_RESULT_OUTCOME",
    );
  }
}

// ── Ollama 流式 chunk ─────────────────────────────────────────

type OllamaChatChunk = {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  // 计时与用量（仅 final chunk 有值）
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
};

// ── NDJSON 解析 ───────────────────────────────────────────────

function parseOllamaNDJSON(buffer: string): { chunks: OllamaChatChunk[]; rest: string; malformedLines: number } {
  const chunks: OllamaChatChunk[] = [];
  let rest = buffer;
  let malformedLines = 0;

  while (true) {
    const lineEnd = rest.indexOf("\n");
    if (lineEnd === -1) break;

    const line = rest.slice(0, lineEnd).trim();
    rest = rest.slice(lineEnd + 1);

    if (!line) continue;

    try {
      const parsed = JSON.parse(line);
      // Ollama chunks have a "message" field in streaming mode
      if (parsed && typeof parsed === "object" && "message" in parsed) {
        chunks.push(parsed as OllamaChatChunk);
      } else {
        malformedLines++;
      }
    } catch {
      malformedLines++;
    }
  }

  return { chunks, rest, malformedLines };
}

function rollbackTrailingAssistantMessages(messages: OllamaMessage[]): void {
  while (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
    messages.pop();
  }
}

function isOllamaToolCalls(value: unknown): value is OllamaToolCall[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (!entry || typeof entry !== "object" || !("function" in entry)) return false;
      const fn = (entry as { function?: unknown }).function;
      return (
        !!fn &&
        typeof fn === "object" &&
        "name" in fn &&
        typeof (fn as { name?: unknown }).name === "string" &&
        "arguments" in fn &&
        typeof (fn as { arguments?: unknown }).arguments === "object" &&
        (fn as { arguments?: unknown }).arguments !== null
      );
    })
  );
}

// ── Adapter ───────────────────────────────────────────────────

export class OllamaAdapter extends AdapterBase {
  readonly kind = "ollama" as const;
  readonly nativeStreaming = true;

  private baseUrl: string;
  private apiKey: string | undefined;
  private fetchFn: FetchFn;

  constructor(options: OllamaAdapterOptions = {}) {
    super();
    this.baseUrl = options.baseUrl ?? "http://localhost:11434";
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  // ── buildRequest ──────────────────────────────────────────

  protected buildRequest(request: NormalizedRequest): OllamaChatRequest {
    if (request.toolChoice && request.toolChoice !== "auto") {
      throw new AIRequestError("ollama does not support explicit toolChoice", "UNSUPPORTED_TOOL_CHOICE");
    }

    const messages: OllamaMessage[] = [];

    // handle instructions → system message
    if (request.instructions) {
      messages.push({ role: "system", content: instructionsToOllamaText(request.instructions) });
    }

    for (const item of request.input) {
      switch (item.type) {
        case "message": {
          const role = item.role;
          messages.push({
            role,
            content: contentBlocksToText(ensureOllamaTextBlocks(item.content, `input message (${item.role}) content`)),
          });
          break;
        }
        case "tool_call": {
          // Ollama expects tool_calls on the last assistant message
          const lastAssistant = messages.findLast((m) => m.role === "assistant");
          const tc: OllamaToolCall = {
            function: {
              name: item.name,
              arguments: parseOllamaToolArguments(item),
            },
          };
          if (lastAssistant) {
            lastAssistant.tool_calls = [...(lastAssistant.tool_calls ?? []), tc];
          } else {
            messages.push({ role: "assistant", content: "", tool_calls: [tc] });
          }
          break;
        }
        case "tool_result": {
          assertOllamaToolResultOutcome(item.outcome);
          messages.push({
            role: "tool",
            content: contentBlocksToText(ensureOllamaTextBlocks(item.content, `tool_result ${item.callId} content`)),
          });
          break;
        }
        case "reasoning": {
          // Ollama doesn't support reasoning in input; convert to text message
          messages.push({
            role: "assistant",
            content: contentBlocksToText(ensureOllamaReasoningBlocks(item.content, "reasoning content")),
          });
          break;
        }
        case "opaque": {
          // Best-effort restore from opaque replay
          if (
            item.source === "ollama" &&
            item.purpose === "replay" &&
            typeof item.payload === "object" &&
            item.payload !== null
          ) {
            const payload = item.payload as Record<string, unknown>;
            if (payload.role === "assistant" && typeof payload.content === "string") {
              rollbackTrailingAssistantMessages(messages);
              messages.push({
                role: "assistant",
                content: payload.content,
                tool_calls: isOllamaToolCalls(payload.tool_calls) ? payload.tool_calls : undefined,
              });
            }
          }
          break;
        }
      }
    }

    const body: OllamaChatRequest = {
      model: request.model,
      messages,
      stream: true,
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(
        (t): OllamaTool => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema as Record<string, unknown>,
          },
        }),
      );
    }

    if (request.temperature !== undefined || request.maxOutputTokens !== undefined) {
      body.options = {};
      if (request.temperature !== undefined) body.options.temperature = request.temperature;
      if (request.maxOutputTokens !== undefined) body.options.num_predict = request.maxOutputTokens;
    }

    return body;
  }

  // ── runStream ─────────────────────────────────────────────

  protected async *runStream(
    providerRequest: OllamaChatRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    const auxiliary = this.createAuxiliaryState(request);
    if (request.metadata) {
      yield factory.responseWarning("Request metadata is not supported by the Ollama adapter", "UNSUPPORTED_METADATA");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await this.fetchFn(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(providerRequest),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`Ollama API error ${response.status}: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Response body is not readable");
    }

    const output: OutputItem[] = [];
    const decoder = new TextDecoder();
    let buffer = "";

    // 累积状态
    let responseId: string | undefined;
    let accumulatedContent = "";
    let currentMessageId = "";
    let hasMessageStarted = false;

    // tool_calls 累积（于 final chunk 到达）
    let pendingToolCalls: Array<{ id: string; name: string; argumentsText: string; argumentsJson?: unknown }> = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { chunks, rest, malformedLines } = parseOllamaNDJSON(buffer);
        buffer = rest;

        const malformedWarning = emitMalformedStreamWarning(factory, {
          count: malformedLines,
          providerLabel: "Ollama",
          transportLabel: "NDJSON line(s)",
        });
        if (malformedWarning) {
          yield malformedWarning;
        }

        for (const chunk of chunks) {
          responseId = chunk.created_at;

          const msg = chunk.message;

          // 处理 content delta
          if (msg.content) {
            if (!hasMessageStarted) {
              currentMessageId = `msg-${chunk.created_at}`;
              hasMessageStarted = true;
              yield factory.messageStarted(currentMessageId);
            }
            accumulatedContent += msg.content;
            yield factory.messageDelta(currentMessageId, msg.content);
          }

          // 处理 tool_calls (整块到达，在最终 chunk 中)
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            for (const tc of msg.tool_calls) {
              const tcId = `tc-${chunk.created_at}-${tc.function.name}`;
              const argsText = JSON.stringify(tc.function.arguments);
              pendingToolCalls.push({
                id: tcId,
                name: tc.function.name,
                argumentsText: argsText,
                argumentsJson: tc.function.arguments,
              });
            }
          }

          // 处理 done_reason (final chunk)
          if (chunk.done) {
            // 如果有未开始的 message 但没内容，发一个空消息启动
            if (accumulatedContent === "" && pendingToolCalls.length > 0 && !hasMessageStarted) {
              currentMessageId = `msg-${chunk.created_at}`;
              hasMessageStarted = true;
              yield factory.messageStarted(currentMessageId);
            }

            // 完成消息（如果有累积的内容或正在进行的消息）
            if (hasMessageStarted) {
              const message = messageItem([textBlock(accumulatedContent)], { id: currentMessageId });
              yield factory.messageCompleted(message);
              if (accumulatedContent) {
                output.push(message);
              }
            }

            // 发出 tool_call 完成事件
            for (const pending of pendingToolCalls) {
              const toolCall = toolCallItem(pending.id, pending.name, pending.argumentsText, pending.argumentsJson);
              yield factory.toolCallStarted(pending.id, pending.name);
              yield factory.toolCallDelta(pending.id, { argumentsText: pending.argumentsText });
              yield factory.toolCallCompleted(toolCall);
              output.push(toolCall);
            }

            // 提取 usage
            if (
              request.include?.usage !== "off" &&
              (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined)
            ) {
              auxiliary.recordUsage(
                usageFromOllama({
                  prompt_eval_count: chunk.prompt_eval_count,
                  eval_count: chunk.eval_count,
                }),
                "final",
                {
                  prompt_eval_count: chunk.prompt_eval_count,
                  eval_count: chunk.eval_count,
                },
              );
            }

            // 构建 stop reason
            const stopReason = chunk.done_reason ? mapStopReason(chunk.done_reason) : undefined;

            // 构建 replay
            const replay = replayFromOutput(output);

            // 附加 opaque replay（若有关联的 assistant 消息）
            if (accumulatedContent || pendingToolCalls.length > 0) {
              replay.push(
                opaqueItem("ollama", "replay", {
                  role: "assistant",
                  content: accumulatedContent,
                  tool_calls: pendingToolCalls.map((tc) => ({
                    function: { name: tc.name, arguments: tc.argumentsJson },
                  })),
                }),
              );
            }

            const auxiliaryResult = await auxiliary.finalize(factory);
            for (const event of auxiliaryResult.events) {
              yield event;
            }

            yield factory.responseCompleted(
              this.buildResponse(
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
                  rawResponseId: chunk.created_at,
                },
                factory,
              ),
            );

            // 重置累积状态
            accumulatedContent = "";
            currentMessageId = "";
            hasMessageStarted = false;
            pendingToolCalls = [];
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (buffer.trim().length > 0) {
      yield factory.responseWarning("Stream ended with an incomplete Ollama NDJSON line", "STREAM_ERROR");
    }

    // 流结束但无 done=true（断流保护）
    if (hasMessageStarted || pendingToolCalls.length > 0) {
      yield factory.responseWarning("Stream ended without a done signal", "INCOMPLETE_STREAM");

      if (hasMessageStarted) {
        const message = messageItem([textBlock(accumulatedContent)], { id: currentMessageId });
        yield factory.messageCompleted(message);
        if (accumulatedContent) {
          output.push(message);
        }
      }

      for (const pending of pendingToolCalls) {
        const toolCall = toolCallItem(pending.id, pending.name, pending.argumentsText, pending.argumentsJson);
        yield factory.toolCallStarted(pending.id, pending.name);
        yield factory.toolCallDelta(pending.id, { argumentsText: pending.argumentsText });
        yield factory.toolCallCompleted(toolCall);
        output.push(toolCall);
      }

      const replay = replayFromOutput(output);
      const auxiliaryResult = await auxiliary.finalize(factory);
      for (const event of auxiliaryResult.events) {
        yield event;
      }
      yield factory.responseCompleted(
        this.buildResponse(
          request,
          {
            output,
            replay,
            usage: auxiliaryResult.usage,
            billing: auxiliaryResult.billing,
            auxiliary: auxiliaryResult.auxiliary,
            warnings: auxiliaryResult.warnings,
            metadataSources: auxiliaryResult.metadataSources,
            rawResponseId: responseId,
          },
          factory,
        ),
      );
    }
  }
}
