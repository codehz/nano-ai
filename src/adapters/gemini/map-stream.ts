/**
 * GeminiAdapter — stream 映射
 */

import { AIRequestError, WarningCode } from "../../runtime/errors.js";
import {
  textBlock,
  opaqueItem,
  mapStopReason,
} from "../../canonical/index.js";
import { createStreamingItemSession } from "../../provider/streaming-item-session.js";
import { usageFromGemini } from "../../provider/usage/index.js";
import { createDataLineSseParser } from "../../provider/transport/parser.js";
import { finalizeStreamTurn } from "../../provider/finalize-stream-turn.js";
import { OPAQUE_SOURCE } from "../../provider/opaque-sources.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";

import type { NormalizedRequest, AIStreamEvent, StopReason, ContentBlock } from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import type {
  GeminiPart,
  GeminiContent,
  GeminiGenerateContentRequest,
  GeminiStreamChunk,
} from "./types.js";


export const mapper = new NormalizedRequestMapper("gemini");

export function normalizeModelPath(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

export function isGeminiPart(value: unknown): value is GeminiPart {
  return !!value && typeof value === "object";
}

export function isGeminiContent(value: unknown): value is GeminiContent {
  if (!value || typeof value !== "object") return false;
  const content = value as Record<string, unknown>;
  if (content.role !== "user" && content.role !== "model") return false;
  if (!Array.isArray(content.parts)) return false;
  return content.parts.every(isGeminiPart);
}

export function assertGeminiReplayContent(content: unknown, field: string): asserts content is GeminiContent {
  if (!isGeminiContent(content)) {
    throw new AIRequestError(
      `Invalid opaque replay payload: ${field} is not a valid Gemini content object`,
      "INVALID_OPAQUE_REPLAY",
    );
  }
}

export function appendPart(contents: GeminiContent[], role: "user" | "model", part: GeminiPart): void {
  const last = contents[contents.length - 1];
  if (last && last.role === role) {
    last.parts.push(part);
    return;
  }
  contents.push({ role, parts: [part] });
}

export function textPartsFromBlocks(blocks: ContentBlock[], field: string): GeminiPart[] {
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

export function clonePart(part: GeminiPart): GeminiPart {
  return { ...part };
}

export function cloneContent(content: GeminiContent): GeminiContent {
  return {
    role: content.role,
    parts: content.parts.map(clonePart),
  };
}

export function mergeModelParts(base: GeminiPart[], incoming: GeminiPart[]): GeminiPart[] {
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


export type GeminiAdapterStreamHost = {
  beginJsonStream: (
    factory: EventFactory,
    request: NormalizedRequest,
  ) => import("../../provider/transport/run-json-stream.js").ProviderJsonStreamSession;
  baseUrl: string;
  apiKey?: string;
  mergeHeaders: (headers: Record<string, string>) => Record<string, string>;
  
};

export async function* mapGeminiStream(
  host: GeminiAdapterStreamHost,
  providerRequest: GeminiGenerateContentRequest,
  factory: EventFactory,
  request: NormalizedRequest,
): AsyncIterable<AIStreamEvent> {
  const session = host.beginJsonStream(factory, request);
  const { auxiliary, gate } = session;
  const items = createStreamingItemSession(factory);

  if (request.metadata) {
    yield factory.responseWarning(
      "Request metadata is not supported by the Gemini adapter",
      WarningCode.UNSUPPORTED_METADATA,
    );
  }

  const modelPath = normalizeModelPath(request.model);
  await session.open({
    url: `${host.baseUrl}/models/${modelPath}:streamGenerateContent?alt=sse`,
    headers: host.mergeHeaders({
      "Content-Type": "application/json",
      "x-goog-api-key": host.apiKey ?? "",
    }),
    body: providerRequest,
  });

  const parser = createDataLineSseParser<GeminiStreamChunk>();

  let responseId: string | undefined;
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
    if (!currentMessageId) currentMessageId = `msg-${responseId ?? request.requestId}`;
    const started = items.ensureMessageStarted(currentMessageId);
    if (started) {
      hasMessageStarted = true;
      yield started;
    }
  };

  const ensureReasoningStarted = function* (): Generator<AIStreamEvent> {
    if (!currentReasoningId) currentReasoningId = `reason-${responseId ?? request.requestId}`;
    const started = items.ensureReasoningStarted(currentReasoningId, "full");
    if (started) {
      hasReasoningStarted = true;
      yield started;
    }
  };

  const finalizePendingItems = function* (): Generator<AIStreamEvent> {
    if (hasReasoningStarted && items.isActive(currentReasoningId)) {
      yield items.completeReasoning(currentReasoningId);
    }

    if (hasMessageStarted && items.isActive(currentMessageId)) {
      yield items.completeMessage(currentMessageId);
    }

    if (pendingToolCalls.length > 1) {
      yield factory.responseWarning(
        `Gemini delivered ${pendingToolCalls.length} tool call(s) in this turn; arguments arrive as whole objects`,
        WarningCode.TOOL_CALL_BATCHED,
      );
    }

    for (const pending of pendingToolCalls) {
      if (items.isActive(pending.id)) {
        yield items.completeToolCall(pending.id);
      }
    }
  };

  const emitCompleted = async function* (
    reason: StopReason | undefined,
    rawResponseId: string | undefined,
  ): AsyncIterable<AIStreamEvent> {
    // finalize 仅应在首次 complete 前执行；session.complete 内部 gate 防重
    if (gate.completed) {
      yield factory.responseWarning("Duplicate finish signal ignored", WarningCode.DUPLICATE_FINISH);
      return;
    }

    yield* finalizePendingItems();

    yield* finalizeStreamTurn(session, items, {
      stopReason: reason,
      rawResponseId,
      opaque:
        replayParts.length > 0
          ? opaqueItem(OPAQUE_SOURCE.GEMINI, "replay", {
              replaceCanonical: true,
              content: {
                role: "model",
                parts: replayParts.map(clonePart),
              },
            })
          : null,
    });
  };

  for await (const batch of session.batches({
    parser,
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
          WarningCode.CONTENT_FILTER,
        );
        if (!gate.completed) {
          yield* emitCompleted(stopReason, responseId);
        }
        continue;
      }

      if (gate.completed) {
        if (chunk.candidates?.some((c) => c.finishReason)) {
          yield factory.responseWarning("Duplicate finish signal ignored", WarningCode.DUPLICATE_FINISH);
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
          yield items.startToolCall(id, name);
          yield items.deltaToolCall(id, { argumentsText });
          continue;
        }

        if (typeof part.text !== "string" || part.text.length === 0) {
          // thoughtSignature-only / 空 part：仅保留在 replay
          continue;
        }

        if (part.thought) {
          yield* ensureReasoningStarted();
          yield items.deltaReasoning(currentReasoningId, textBlock(part.text));
        } else {
          yield* ensureMessageStarted();
          yield items.deltaMessage(currentMessageId, textBlock(part.text));
        }
      }

      if (candidate.finishReason) {
        const reason = mapStopReason(candidate.finishReason);
        // 有 tool_call 时优先 tool_call 语义
        const effectiveReason =
          pendingToolCalls.length > 0 && (reason === "end_turn" || reason === "unknown") ? "tool_call" : reason;
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
      // 契约差异：Gemini 空流也 emit completed；chat/ollama 仅在有 pending item 时 incomplete complete
      yield* emitCompleted(undefined, responseId);
    }
  }
}
