/**
 * Gemini Adapter
 *
 * 接入 Google Gemini Developer API 原生 generateContent 流：
 * POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 *
 * 能力:
 * - 文本消息流（parts[].text）
 * - 思维链（parts[].thought + thoughtSignature）
 * - 工具调用（parts[].functionCall，整块 args）
 * - usageMetadata → canonical Usage
 * - opaque replay 保留 model content / thoughtSignature
 *
 * 限制（v1）:
 * - 不支持多模态输入、grounding、codeExecution、structured output
 * - tool_call 不保证逐 token 流式
 */

import { AdapterBase } from "../../provider/base.js";
import { AIRequestError, WarningCode } from "../../runtime/errors.js";
import {
  textBlock,
  messageItem,
  reasoningItem,
  toolCallItem,
  opaqueItem,
  replayFromOutput,
  mapStopReason,
  contentBlocksToText,
} from "../../canonical/index.js";
import { assertOpaqueReplayEnvelope } from "../../provider/security.js";
import { usageFromGemini } from "../../provider/usage/index.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";
import { createChatCompletionsSseParser } from "../../provider/transport/parser.js";
import {
  openProviderJsonStream,
  iterateProviderStreamBatches,
  createCompletionGate,
} from "../../provider/transport/open-stream.js";
import { mergeProviderHeaders, applyExtraBody } from "../../provider/request-options.js";
import { mapGeminiThinking } from "../../provider/reasoning.js";

import type {
  NormalizedRequest,
  AIStreamEvent,
  OutputItem,
  FetchFn,
  StopReason,
  ContentBlock,
} from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";

// ── 选项类型 ──────────────────────────────────────────────────

import type {
  GeminiAdapterOptions,
  GeminiPart,
  GeminiContent,
  GeminiTool,
  GeminiFunctionCallingConfig,
  GeminiGenerateContentRequest,
  GeminiStreamChunk
} from "./types.js";

const mapper = new NormalizedRequestMapper("gemini");

function normalizeModelPath(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

function isGeminiPart(value: unknown): value is GeminiPart {
  return !!value && typeof value === "object";
}

function isGeminiContent(value: unknown): value is GeminiContent {
  if (!value || typeof value !== "object") return false;
  const content = value as Record<string, unknown>;
  if (content.role !== "user" && content.role !== "model") return false;
  if (!Array.isArray(content.parts)) return false;
  return content.parts.every(isGeminiPart);
}

function assertGeminiReplayContent(content: unknown, field: string): asserts content is GeminiContent {
  if (!isGeminiContent(content)) {
    throw new AIRequestError(
      `Invalid opaque replay payload: ${field} is not a valid Gemini content object`,
      "INVALID_OPAQUE_REPLAY",
    );
  }
}

function appendPart(contents: GeminiContent[], role: "user" | "model", part: GeminiPart): void {
  const last = contents[contents.length - 1];
  if (last && last.role === role) {
    last.parts.push(part);
    return;
  }
  contents.push({ role, parts: [part] });
}

function textPartsFromBlocks(blocks: ContentBlock[], field: string): GeminiPart[] {
  const supported = mapper.ensureTextBlocks(blocks, field);
  return supported.map((block) => {
    if (block.type === "text") return { text: block.text };
    if (block.type === "json") return { text: JSON.stringify(block.json) };
    throw new AIRequestError(
      `gemini does not support content block type "${block.type}" in ${field}`,
      "UNSUPPORTED_CONTENT_BLOCK",
    );
  });
}

function clonePart(part: GeminiPart): GeminiPart {
  return { ...part };
}

function cloneContent(content: GeminiContent): GeminiContent {
  return {
    role: content.role,
    parts: content.parts.map(clonePart),
  };
}

function mergeModelParts(base: GeminiPart[], incoming: GeminiPart[]): GeminiPart[] {
  const result = base.map(clonePart);
  for (const part of incoming) {
    const last = result[result.length - 1];
    const sameTextBucket =
      last &&
      typeof last.text === "string" &&
      typeof part.text === "string" &&
      !!last.thought === !!part.thought &&
      !last.functionCall &&
      !part.functionCall &&
      !last.functionResponse &&
      !part.functionResponse;

    if (sameTextBucket) {
      last.text = `${last.text ?? ""}${part.text ?? ""}`;
      if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature;
      continue;
    }

    result.push(clonePart(part));
  }
  return result;
}

// ── Adapter ───────────────────────────────────────────────────

export class GeminiAdapter extends AdapterBase {
  readonly kind = "gemini" as const;
  readonly isSyntheticStream = false;

  private apiKey: string;
  private baseUrl: string;
  private fetchFn: FetchFn;
  private headers: Record<string, string> | undefined;
  private extraBody: Record<string, unknown> | undefined;

  constructor(options: GeminiAdapterOptions) {
    super();
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.headers = options.headers;
    this.extraBody = options.extraBody;
  }

  // ── buildRequest ──────────────────────────────────────────

  protected buildRequest(request: NormalizedRequest): GeminiGenerateContentRequest {
    mapper.assertNoServerTools(request.serverTools);

    const contents: GeminiContent[] = [];
    let systemInstruction: GeminiGenerateContentRequest["systemInstruction"];

    if (request.instructions) {
      systemInstruction = {
        parts: [{ text: mapper.mapInstructions(request.instructions) }],
      };
    }

    for (const item of request.input) {
      switch (item.type) {
        case "message": {
          const role = item.role === "assistant" ? "model" : "user";
          for (const part of textPartsFromBlocks(item.content, `input message (${item.role}) content`)) {
            appendPart(contents, role, part);
          }
          break;
        }
        case "tool_call": {
          const part: GeminiPart = {
            functionCall: {
              id: item.id,
              name: item.name,
              args: mapper.parseToolArguments(item),
            },
          };
          appendPart(contents, "model", part);
          break;
        }
        case "tool_result": {
          let response: Record<string, unknown>;
          try {
            const text = mapper.textFromBlocks(item.content, `tool_result ${item.callId} content`);
            const parsed: unknown = text ? JSON.parse(text) : {};
            response =
              parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : { result: text };
          } catch {
            response = {
              result: mapper.textFromBlocks(item.content, `tool_result ${item.callId} content`),
            };
          }

          appendPart(contents, "user", {
            functionResponse: {
              id: item.callId,
              name: item.toolName,
              response,
            },
          });
          break;
        }
        case "reasoning": {
          const text = contentBlocksToText(mapper.ensureReasoningBlocks(item.content, "reasoning content"));
          appendPart(contents, "model", { text, thought: true });
          break;
        }
        case "opaque": {
          if (item.source !== "gemini" || item.purpose !== "replay") break;
          assertOpaqueReplayEnvelope(item.payload);
          const payload = item.payload as Record<string, unknown>;
          if (payload.replaceCanonical === true && "content" in payload) {
            assertGeminiReplayContent(payload.content, "content");
            // 回放完整 model turn：去掉尾部 model，避免与 canonical assistant 重复
            while (contents.length > 0 && contents[contents.length - 1]?.role === "model") {
              contents.pop();
            }
            contents.push(cloneContent(payload.content));
          } else if (isGeminiContent(payload)) {
            while (contents.length > 0 && contents[contents.length - 1]?.role === "model") {
              contents.pop();
            }
            contents.push(cloneContent(payload));
          }
          break;
        }
      }
    }

    const body: GeminiGenerateContentRequest = {
      contents,
    };

    if (systemInstruction) body.systemInstruction = systemInstruction;

    body.tools = mapper.mapToolsIfPresent(
      request.tools,
      (tool): GeminiTool => ({
        functionDeclarations: [
          {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        ],
      }),
    );

    // Gemini tools 通常合并为一个 tool 对象下的 declarations
    if (body.tools && body.tools.length > 1) {
      body.tools = [
        {
          functionDeclarations: body.tools.flatMap((tool) => tool.functionDeclarations),
        },
      ];
    }

    const functionCallingConfig = mapper.mapToolChoice<GeminiFunctionCallingConfig>(request.toolChoice, {
      auto: { mode: "AUTO" },
      none: { mode: "NONE" },
      tool: (name) => ({ mode: "ANY", allowedFunctionNames: [name] }),
    });
    if (functionCallingConfig) {
      body.toolConfig = { functionCallingConfig };
    }

    const generationConfig: NonNullable<GeminiGenerateContentRequest["generationConfig"]> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = request.maxOutputTokens;
    if (request.reasoningLevel !== undefined) {
      generationConfig.thinkingConfig = mapGeminiThinking(request.reasoningLevel);
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    return applyExtraBody(body, this.extraBody);
  }

  // ── runStream ─────────────────────────────────────────────

  protected async *runStream(
    providerRequest: GeminiGenerateContentRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    const auxiliary = this.createAuxiliaryState(request);
    const gate = createCompletionGate();

    if (request.metadata) {
      yield factory.responseWarning(
        "Request metadata is not supported by the Gemini adapter",
        "UNSUPPORTED_METADATA",
      );
    }

    const modelPath = normalizeModelPath(request.model);
    const { reader } = await openProviderJsonStream({
      fetchFn: this.fetchFn,
      url: `${this.baseUrl}/models/${modelPath}:streamGenerateContent?alt=sse`,
      headers: mergeProviderHeaders(
        {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        this.headers,
      ),
      body: providerRequest,
      signal: request.signal,
    });

    const parser = createChatCompletionsSseParser<GeminiStreamChunk>();
    const output: OutputItem[] = [];

    let responseId: string | undefined;
    let accumulatedContent = "";
    let accumulatedReasoning = "";
    let currentMessageId = "";
    let currentReasoningId = "";
    let hasMessageStarted = false;
    let hasReasoningStarted = false;
    let pendingToolCalls: Array<{ id: string; name: string; argumentsText: string }> = [];
    let replayParts: GeminiPart[] = [];
    let toolCallIndex = 0;
    let stopReason: StopReason | undefined;
    let sawPromptBlock = false;

    const ensureMessageStarted = function* (): Generator<AIStreamEvent> {
      if (hasMessageStarted) return;
      currentMessageId = `msg-${responseId ?? request.requestId}`;
      hasMessageStarted = true;
      accumulatedContent = "";
      yield factory.messageStarted(currentMessageId);
    };

    const ensureReasoningStarted = function* (): Generator<AIStreamEvent> {
      if (hasReasoningStarted) return;
      currentReasoningId = `reason-${responseId ?? request.requestId}`;
      hasReasoningStarted = true;
      accumulatedReasoning = "";
      yield factory.reasoningStarted(currentReasoningId, "full");
    };

    const finalizePendingItems = function* (): Generator<AIStreamEvent> {
      if (hasReasoningStarted) {
        yield factory.reasoningCompleted(currentReasoningId);
        if (accumulatedReasoning) {
          output.push(reasoningItem([textBlock(accumulatedReasoning)], "full", currentReasoningId));
        }
      }

      if (hasMessageStarted) {
        yield factory.messageCompleted(currentMessageId);
        if (accumulatedContent) {
          output.push(messageItem([textBlock(accumulatedContent)], { id: currentMessageId }));
        }
      }

      if (pendingToolCalls.length > 1) {
        yield factory.responseWarning(
          `Gemini delivered ${pendingToolCalls.length} tool call(s) in this turn; arguments arrive as whole objects`,
          WarningCode.TOOL_CALL_BATCHED,
        );
      }

      for (const pending of pendingToolCalls) {
        yield factory.toolCallCompleted(pending.id);
        output.push(toolCallItem(pending.id, pending.name, pending.argumentsText));
      }
    };

    const emitCompleted = async function* (
      this: GeminiAdapter,
      reason: StopReason | undefined,
      rawResponseId: string | undefined,
    ): AsyncIterable<AIStreamEvent> {
      if (!gate.tryComplete()) {
        yield factory.responseWarning("Duplicate finish signal ignored", "DUPLICATE_FINISH");
        return;
      }

      yield* finalizePendingItems();

      const replay = [...replayFromOutput(output)];
      if (replayParts.length > 0) {
        replay.push(
          opaqueItem("gemini", "replay", {
            replaceCanonical: true,
            content: {
              role: "model",
              parts: replayParts.map(clonePart),
            },
          }),
        );
      }

      yield* this.emitStreamCompleted(factory, request, auxiliary, {
        output,
        replay,
        stopReason: reason,
        rawResponseId,
      });
    }.bind(this);

    for await (const batch of iterateProviderStreamBatches({
      reader,
      parser,
      factory,
      providerLabel: "Gemini",
      transportLabel: "SSE event(s)",
      incompleteMessage: "Stream ended with an incomplete Gemini SSE frame",
    })) {
      for (const warning of batch.warnings) yield warning;

      for (const chunk of batch.items) {
        if (chunk.responseId) responseId = chunk.responseId;

        if (chunk.usageMetadata && request.include?.usage !== "off") {
          auxiliary.recordUsage(usageFromGemini(chunk.usageMetadata), "stream", chunk.usageMetadata);
        }

        if (chunk.promptFeedback?.blockReason) {
          sawPromptBlock = true;
          stopReason = "content_filter";
          yield factory.responseWarning(
            `Gemini blocked the prompt: ${chunk.promptFeedback.blockReason}`,
            "CONTENT_FILTER",
          );
          if (!gate.completed) {
            yield* emitCompleted(stopReason, responseId);
          }
          continue;
        }

        if (gate.completed) {
          if (chunk.candidates?.some((c) => c.finishReason)) {
            yield factory.responseWarning("Duplicate finish signal ignored", "DUPLICATE_FINISH");
          }
          continue;
        }

        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;

        const parts = candidate.content?.parts ?? [];
        if (parts.length > 0) {
          replayParts = mergeModelParts(replayParts, parts);
        }

        for (const part of parts) {
          if (part.functionCall) {
            const name = part.functionCall.name;
            const id = part.functionCall.id ?? `gemini-fc-${toolCallIndex++}-${responseId ?? request.requestId}`;
            const args = part.functionCall.args ?? {};
            const argumentsText = JSON.stringify(args);

            // functionCall 前若有未完成 message/reasoning，先不 complete，等 finish
            pendingToolCalls.push({ id, name, argumentsText });
            yield factory.toolCallStarted(id, name);
            yield factory.toolCallDelta(id, { argumentsText });
            continue;
          }

          if (typeof part.text !== "string" || part.text.length === 0) {
            // thoughtSignature-only / 空 part：仅保留在 replay
            continue;
          }

          if (part.thought) {
            yield* ensureReasoningStarted();
            accumulatedReasoning += part.text;
            yield factory.reasoningDelta(currentReasoningId, textBlock(part.text));
          } else {
            yield* ensureMessageStarted();
            accumulatedContent += part.text;
            yield factory.messageDelta(currentMessageId, textBlock(part.text));
          }
        }

        if (candidate.finishReason) {
          const reason = mapStopReason(candidate.finishReason);
          // 有 tool_call 时优先 tool_call 语义
          const effectiveReason =
            pendingToolCalls.length > 0 && (reason === "end_turn" || reason === "unknown")
              ? "tool_call"
              : reason;
          stopReason = effectiveReason;
          yield* emitCompleted(effectiveReason, responseId);
        }
      }
    }

    if (!gate.completed) {
      if (hasMessageStarted || hasReasoningStarted || pendingToolCalls.length > 0 || sawPromptBlock) {
        if (!sawPromptBlock) {
          yield factory.responseWarning("Stream ended without a finishReason", WarningCode.STREAM_INCOMPLETE);
        }
        yield* emitCompleted(stopReason, responseId);
      } else {
        // 空流：仍需 completed 以保持契约
        yield* emitCompleted(undefined, responseId);
      }
    }
  }
}
