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

import { HttpAdapterBase } from "../../provider/http-adapter.js";
import { AIRequestError, WarningCode } from "../../runtime/errors.js";
import {
  textBlock,
  messageItem,
  toolCallItem,
  opaqueItem,
  replayFromOutput,
  mapStopReason,
  contentBlocksToText,
} from "../../canonical/index.js";
import { acceptOpaqueReplay } from "../../provider/opaque-replay.js";
import { usageFromOllama } from "../../provider/usage/index.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";
import { createNdjsonLineParser } from "../../provider/transport/parser.js";
import {
  openProviderJsonStream,
  iterateProviderStreamBatches,
  createCompletionGate,
} from "../../provider/transport/open-stream.js";
import { mapOllamaThink } from "../../provider/reasoning.js";

import type { NormalizedRequest, AIStreamEvent, OutputItem, StopReason } from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";

// ── 选项类型 ──────────────────────────────────────────────────

import type { OllamaAdapterOptions, OllamaChatRequest, OllamaMessage, OllamaToolCall, OllamaTool } from "./types.js";

const mapper = new NormalizedRequestMapper("ollama");

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

/** opaque emit 用：非法 JSON 回退 {}，不泄原生 SyntaxError。 */
function safeParseToolArgumentsObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

// ── Adapter ───────────────────────────────────────────────────

export class OllamaAdapter extends HttpAdapterBase {
  readonly kind = "ollama" as const;
  readonly isSyntheticStream = false;

  constructor(options: OllamaAdapterOptions = {}) {
    super(options, { baseUrl: "http://localhost:11434" });
  }

  // ── buildRequest ──────────────────────────────────────────

  protected buildRequest(request: NormalizedRequest): OllamaChatRequest {
    mapper.assertNoServerTools(request.serverTools);

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
            content: mapper.textFromBlocks(item.content, `input message (${item.role}) content`),
          });
          break;
        }
        case "tool_call": {
          // Ollama expects tool_calls on the last assistant message
          const lastAssistant = messages.findLast((m) => m.role === "assistant");
          const tc: OllamaToolCall = {
            function: {
              name: item.name,
              arguments: mapper.parseToolArguments(item),
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
            content: mapper.textFromBlocks(item.content, `tool_result ${item.callId} content`),
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
          const payload = acceptOpaqueReplay(item, "ollama");
          if (!payload) break;
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

    const toolChoice = request.toolChoice;
    const selectedTools =
      toolChoice === "none"
        ? []
        : toolChoice && typeof toolChoice === "object"
          ? request.tools?.filter((tool) => tool.name === toolChoice.name)
          : request.tools;

    if (selectedTools && selectedTools.length > 0) {
      body.tools = selectedTools.map(
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

    if (request.reasoningLevel !== undefined) {
      body.think = mapOllamaThink(request.reasoningLevel);
    }

    return this.withExtraBody(body);
  }

  // ── runStream ─────────────────────────────────────────────

  protected async *runStream(
    providerRequest: OllamaChatRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    const auxiliary = this.createAuxiliaryState(request);
    const gate = createCompletionGate();

    if (request.toolChoice && request.toolChoice !== "auto") {
      yield factory.responseWarning(
        request.toolChoice === "none"
          ? "Ollama toolChoice none was mapped by omitting tools"
          : `Ollama cannot force tool choice; only tool "${request.toolChoice.name}" was provided as a best-effort constraint`,
        WarningCode.CAPABILITY_DOWNGRADE,
      );
    }
    if (request.metadata) {
      yield factory.responseWarning(
        "Request metadata is not supported by the Ollama adapter",
        WarningCode.UNSUPPORTED_METADATA,
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const { reader } = await openProviderJsonStream({
      fetchFn: this.fetchFn,
      url: `${this.baseUrl}/api/chat`,
      headers: this.mergeHeaders(headers),
      body: providerRequest,
      signal: request.signal,
    });

    const parser = createNdjsonLineParser<OllamaChatChunk>(
      (value): value is OllamaChatChunk => !!value && typeof value === "object" && "message" in value,
    );

    const output: OutputItem[] = [];
    let responseId: string | undefined;
    let accumulatedContent = "";
    let currentMessageId = "";
    let hasMessageStarted = false;
    let pendingToolCalls: Array<{ id: string; name: string; argumentsText: string }> = [];
    let toolCallIndex = 0;

    const emitCompleted = async function* (
      this: OllamaAdapter,
      stopReason: StopReason | undefined,
      rawResponseId: string | undefined,
    ): AsyncIterable<AIStreamEvent> {
      if (!gate.tryComplete()) {
        yield factory.responseWarning("Duplicate finish signal ignored", WarningCode.DUPLICATE_FINISH);
        return;
      }

      const replay = replayFromOutput(output);
      if (accumulatedContent || pendingToolCalls.length > 0) {
        replay.push(
          opaqueItem("ollama", "replay", {
            role: "assistant",
            content: accumulatedContent,
            tool_calls: pendingToolCalls.map((tc) => ({
              id: tc.id,
              function: { name: tc.name, arguments: safeParseToolArgumentsObject(tc.argumentsText) },
            })),
          }),
        );
      }

      yield* this.emitStreamCompleted(factory, request, auxiliary, {
        output,
        replay,
        stopReason,
        rawResponseId,
      });
    }.bind(this);

    for await (const batch of iterateProviderStreamBatches({
      reader,
      parser,
      factory,
      providerLabel: "Ollama",
      transportLabel: "NDJSON line(s)",
      incompleteMessage: "Stream ended with an incomplete Ollama NDJSON line",
    })) {
      for (const warning of batch.warnings) yield warning;

      for (const chunk of batch.items) {
        responseId = chunk.created_at;

        if (gate.completed) {
          if (chunk.done) {
            yield factory.responseWarning("Duplicate finish signal ignored", WarningCode.DUPLICATE_FINISH);
          }
          continue;
        }

        const msg = chunk.message;

        if (msg.content) {
          if (!hasMessageStarted) {
            currentMessageId = `msg-${chunk.created_at}`;
            hasMessageStarted = true;
            yield factory.messageStarted(currentMessageId);
          }
          accumulatedContent += msg.content;
          yield factory.messageDelta(currentMessageId, textBlock(msg.content));
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            const tcId = `ollama-tc-${request.requestId}-${toolCallIndex++}`;
            const argsText = JSON.stringify(tc.function.arguments);
            pendingToolCalls.push({
              id: tcId,
              name: tc.function.name,
              argumentsText: argsText,
            });
          }
        }

        if (chunk.done) {
          if (accumulatedContent === "" && pendingToolCalls.length > 0 && !hasMessageStarted) {
            currentMessageId = `msg-${chunk.created_at}`;
            hasMessageStarted = true;
            yield factory.messageStarted(currentMessageId);
          }

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
            const toolCall = toolCallItem(pending.id, pending.name, pending.argumentsText);
            yield factory.toolCallStarted(pending.id, pending.name);
            yield factory.toolCallDelta(pending.id, { argumentsText: pending.argumentsText });
            yield factory.toolCallCompleted(pending.id);
            output.push(toolCall);
          }

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

          const stopReason = chunk.done_reason ? mapStopReason(chunk.done_reason) : undefined;
          yield* emitCompleted(stopReason, chunk.created_at);

          accumulatedContent = "";
          currentMessageId = "";
          hasMessageStarted = false;
          pendingToolCalls = [];
        }
      }
    }

    if (!gate.completed && (hasMessageStarted || pendingToolCalls.length > 0)) {
      yield factory.responseWarning("Stream ended without a done signal", WarningCode.STREAM_INCOMPLETE);

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
        const toolCall = toolCallItem(pending.id, pending.name, pending.argumentsText);
        yield factory.toolCallStarted(pending.id, pending.name);
        yield factory.toolCallDelta(pending.id, { argumentsText: pending.argumentsText });
        yield factory.toolCallCompleted(pending.id);
        output.push(toolCall);
      }

      yield* emitCompleted(undefined, responseId);
    }
  }
}
