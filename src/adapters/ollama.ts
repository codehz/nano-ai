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
import { AIProviderError, AIRequestError, AIStreamError, WarningCode } from "../core/errors.js";
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
import { assertOpaqueReplayEnvelope, providerHttpError } from "../helpers/adapter-security.js";
import { usageFromOllama } from "../helpers/usage-mapping.js";
import { NormalizedRequestMapper, splitLines, IncrementalStreamParser } from "../helpers/index.js";
import type { ProviderProfile } from "../helpers/index.js";

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

// ── ProviderProfile & Mapper ────────────────────────────────────

const profile: ProviderProfile = {
  kind: "ollama",
  instructionsMode: "system_message",
  supportedBlockTypes: ["text", "json"] as const,
  reasoningBlockTypes: ["text"] as const,
  capabilities: {
    textStreaming: "native",
    reasoningStreaming: "none",
    toolCallStreaming: "synthetic",
    replay: "opaque",
    usage: "final",
  },
};

const mapper = new NormalizedRequestMapper(profile);

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

/** Opaque replay may carry optional local `id`s; wire tool_calls never include them. */
type OllamaReplayToolCall = OllamaToolCall & { id?: string };

function isOllamaReplayToolCalls(value: unknown): value is OllamaReplayToolCall[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (!entry || typeof entry !== "object" || !("function" in entry)) return false;
      const fn = (entry as { function?: unknown }).function;
      const id = (entry as { id?: unknown }).id;
      if (id !== undefined && typeof id !== "string") return false;
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

function toWireOllamaToolCalls(toolCalls: OllamaReplayToolCall[]): OllamaToolCall[] {
  return toolCalls.map((tc) => ({
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments,
    },
  }));
}

// ── Adapter ───────────────────────────────────────────────────

export class OllamaAdapter extends AdapterBase {
  readonly kind = "ollama" as const;
  readonly capabilities = profile.capabilities;

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
    /** Local-only name → call id queue for best-effort tool_result association (not sent to Ollama). */
    const callIdsByName = new Map<string, string[]>();

    // handle instructions → system message
    if (request.instructions) {
      messages.push({ role: "system", content: mapper.mapInstructions(request.instructions) });
    }

    for (const item of request.input) {
      switch (item.type) {
        case "message": {
          const role = item.role;
          messages.push({
            role,
            content: contentBlocksToText(mapper.ensureTextBlocks(item.content, `input message (${item.role}) content`)),
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
          const queue = callIdsByName.get(item.name) ?? [];
          queue.push(item.id);
          callIdsByName.set(item.name, queue);
          if (lastAssistant) {
            lastAssistant.tool_calls = [...(lastAssistant.tool_calls ?? []), tc];
          } else {
            messages.push({ role: "assistant", content: "", tool_calls: [tc] });
          }
          break;
        }
        case "tool_result": {
          // Best-effort: consume matching id from name queue when present (no wire call_id)
          const queue = callIdsByName.get(item.toolName);
          if (queue && queue.length > 0) {
            queue.shift();
          }
          messages.push({
            role: "tool",
            content: contentBlocksToText(mapper.ensureTextBlocks(item.content, `tool_result ${item.callId} content`)),
          });
          break;
        }
        case "reasoning": {
          // Ollama doesn't support reasoning in input; convert to text message
          messages.push({
            role: "assistant",
            content: contentBlocksToText(mapper.ensureReasoningBlocks(item.content, "reasoning content")),
          });
          break;
        }
        case "opaque": {
          // Best-effort restore from opaque replay (local ids stripped before wire)
          if (item.source !== "ollama" || item.purpose !== "replay") break;
          assertOpaqueReplayEnvelope(item.payload);
          const payload = item.payload as Record<string, unknown>;
          if (payload.role === "assistant" && typeof payload.content === "string") {
            mapper.rollbackTrailingAssistantMessages(messages);
            let replayToolCalls: OllamaReplayToolCall[] | undefined;
            if ("tool_calls" in payload && payload.tool_calls !== undefined) {
              if (!isOllamaReplayToolCalls(payload.tool_calls)) {
                throw new AIRequestError(
                  "Invalid opaque replay payload: tool_calls is not a valid ollama tool_calls array",
                  "INVALID_OPAQUE_REPLAY",
                );
              }
              replayToolCalls = payload.tool_calls;
            }
            // Record name → id order for best-effort tool_result correlation (local only)
            if (replayToolCalls) {
              for (const tc of replayToolCalls) {
                if (tc.id) {
                  const queue = callIdsByName.get(tc.function.name) ?? [];
                  queue.push(tc.id);
                  callIdsByName.set(tc.function.name, queue);
                }
              }
            }
            messages.push({
              role: "assistant",
              content: payload.content,
              tool_calls: replayToolCalls ? toWireOllamaToolCalls(replayToolCalls) : undefined,
            });
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
    let completedEmitted = false;
    if (request.metadata) {
      yield factory.responseWarning("Request metadata is not supported by the Ollama adapter", "UNSUPPORTED_METADATA");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    let response: Response;

    try {
      response = await this.fetchFn(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(providerRequest),
        signal: request.signal,
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

    const parser = new IncrementalStreamParser<OllamaChatChunk>(splitLines, (item: string) => {
      const trimmed = item.trim();
      if (!trimmed) return { status: "ignored" };
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && "message" in parsed) {
          return { status: "parsed", value: parsed as OllamaChatChunk };
        }
        return { status: "malformed" };
      } catch {
        return { status: "malformed" };
      }
    });

    const output: OutputItem[] = [];
    let streamDone = false;

    // 累积状态
    let responseId: string | undefined;
    let accumulatedContent = "";
    let currentMessageId = "";
    let hasMessageStarted = false;

    // tool_calls 累积（于 final chunk 到达）
    let pendingToolCalls: Array<{ id: string; name: string; argumentsText: string; argumentsJson?: unknown }> = [];
    let toolCallIndex = 0;
    const buildResponse = this.buildResponse.bind(this);

    const emitCompleted = async function* (
      stopReason: import("../index.js").StopReason | undefined,
      rawResponseId: string | undefined,
    ): AsyncIterable<AIStreamEvent> {
      if (completedEmitted) {
        yield factory.responseWarning("Duplicate finish signal ignored", "DUPLICATE_FINISH");
        return;
      }

      completedEmitted = true;

      const replay = replayFromOutput(output);

      if (accumulatedContent || pendingToolCalls.length > 0) {
        replay.push(
          opaqueItem("ollama", "replay", {
            role: "assistant",
            content: accumulatedContent,
            tool_calls: pendingToolCalls.map((tc) => ({
              id: tc.id,
              function: { name: tc.name, arguments: tc.argumentsJson },
            })),
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
        const { items: chunks, malformed: malformedLines } = done ? parser.flush() : parser.feed(value as Uint8Array);

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

          if (completedEmitted) {
            if (chunk.done) {
              yield factory.responseWarning("Duplicate finish signal ignored", "DUPLICATE_FINISH");
            }
            continue;
          }

          const msg = chunk.message;

          // 处理 content delta
          if (msg.content) {
            if (!hasMessageStarted) {
              currentMessageId = `msg-${chunk.created_at}`;
              hasMessageStarted = true;
              yield factory.messageStarted(currentMessageId);
            }
            accumulatedContent += msg.content;
            yield factory.messageDelta(currentMessageId, textBlock(msg.content));
          }

          // 处理 tool_calls (整块到达，在最终 chunk 中)
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            for (const tc of msg.tool_calls) {
              const tcId = `ollama-tc-${request.requestId}-${toolCallIndex++}`;
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
              yield factory.messageCompleted(currentMessageId);
              if (accumulatedContent) {
                output.push(message);
              }
            }

            if (pendingToolCalls.length > 0) {
              yield factory.responseWarning(
                `Ollama delivered ${pendingToolCalls.length} tool call(s) as a batch; tool_call streaming is not supported`,
                WarningCode.TOOL_CALL_BATCHED,
              );
            }

            // 发出 tool_call 完成事件
            for (const pending of pendingToolCalls) {
              const toolCall = toolCallItem(pending.id, pending.name, pending.argumentsText, pending.argumentsJson);
              yield factory.toolCallStarted(pending.id, pending.name);
              yield factory.toolCallDelta(pending.id, { argumentsText: pending.argumentsText });
              yield factory.toolCallCompleted(pending.id);
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

            yield* emitCompleted(stopReason, chunk.created_at);

            // 重置累积状态
            accumulatedContent = "";
            currentMessageId = "";
            hasMessageStarted = false;
            pendingToolCalls = [];
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
      yield factory.responseWarning("Stream ended with an incomplete Ollama NDJSON line", "STREAM_ERROR");
    }

    // 流结束但无 done=true（断流保护）
    if (!completedEmitted && (hasMessageStarted || pendingToolCalls.length > 0)) {
      yield factory.responseWarning("Stream ended without a done signal", "INCOMPLETE_STREAM");

      if (hasMessageStarted) {
        const message = messageItem([textBlock(accumulatedContent)], { id: currentMessageId });
        yield factory.messageCompleted(currentMessageId);
        if (accumulatedContent) {
          output.push(message);
        }
      }

      if (pendingToolCalls.length > 0) {
        yield factory.responseWarning(
          `Ollama delivered ${pendingToolCalls.length} tool call(s) as a batch; tool_call streaming is not supported`,
          WarningCode.TOOL_CALL_BATCHED,
        );
      }

      for (const pending of pendingToolCalls) {
        const toolCall = toolCallItem(pending.id, pending.name, pending.argumentsText, pending.argumentsJson);
        yield factory.toolCallStarted(pending.id, pending.name);
        yield factory.toolCallDelta(pending.id, { argumentsText: pending.argumentsText });
        yield factory.toolCallCompleted(pending.id);
        output.push(toolCall);
      }

      yield* emitCompleted(undefined, responseId);
    }
  }
}
