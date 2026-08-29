/**
 * DeltaCompletionsAdapter — stream 映射
 *
 * 完成信号是 SSE 结束，不依赖 finish_reason / index / id。
 */

import { WarningCode } from "../../runtime/errors.js";
import { textBlock, opaqueItem, mapStopReason } from "../../canonical/index.js";
import { createStreamingItemSession } from "../../provider/streaming-item-session.js";
import { createDataLineSseParser } from "../../provider/transport/parser.js";
import { finalizeStreamTurn } from "../../provider/finalize-stream-turn.js";
import { OPAQUE_SOURCE } from "../../provider/opaque-sources.js";

import type { NormalizedRequest, AIStreamEvent, StopReason } from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import type { ProviderJsonStreamSession } from "../../provider/transport/run-json-stream.js";
import type { DeltaChatRequest } from "./types.js";

export type DeltaCompletionsAdapterStreamHost = {
  beginJsonStream: (factory: EventFactory, request: NormalizedRequest) => ProviderJsonStreamSession;
  baseUrl: string;
  apiKey?: string;
  mergeHeaders: (headers: Record<string, string>) => Record<string, string>;
  maxOpaquePayloadBytes: number;
};

export async function* mapDeltaCompletionsStream(
  host: DeltaCompletionsAdapterStreamHost,
  providerRequest: DeltaChatRequest,
  factory: EventFactory,
  request: NormalizedRequest,
): AsyncIterable<AIStreamEvent> {
  const session = host.beginJsonStream(factory, request);
  const { gate } = session;
  const items = createStreamingItemSession(factory);

  if (request.metadata) {
    yield factory.responseWarning(
      "Request metadata is not supported by the Delta Completions adapter",
      WarningCode.UNSUPPORTED_METADATA,
    );
  }
  if (request.reasoningLevel !== undefined) {
    yield factory.responseWarning(
      "Request reasoningLevel is not supported by the Delta Completions adapter",
      WarningCode.CAPABILITY_DOWNGRADE,
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (host.apiKey) {
    headers.Authorization = `Bearer ${host.apiKey}`;
  }

  await session.open({
    url: `${host.baseUrl}/chat/completions`,
    headers: host.mergeHeaders(headers),
    body: providerRequest,
  });

  const parser = createDataLineSseParser<unknown>();

  let responseId: string | undefined;
  let accumulatedContent = "";
  let currentMessageId = "";
  let hasMessageStarted = false;
  let lastFinishReason: string | undefined;
  let warnedExtraChoices = false;
  let warnedIgnoredDelta = false;

  const ensureMessageStarted = function* (idSeed: string): Generator<AIStreamEvent> {
    if (!currentMessageId) currentMessageId = `msg-${idSeed}`;
    const started = items.ensureMessageStarted(currentMessageId);
    if (started) {
      hasMessageStarted = true;
      yield started;
    }
  };

  for await (const batch of session.batches({
    parser,
    providerLabel: "Delta Completions",
    transportLabel: "SSE event(s)",
    incompleteMessage: "Stream ended with an incomplete Delta Completions SSE frame",
  })) {
    for (const warning of batch.warnings) yield warning;

    for (const chunk of batch.items) {
      if (chunk === null || typeof chunk !== "object") continue;

      if ("id" in chunk && typeof chunk.id === "string" && chunk.id) {
        responseId = chunk.id;
      }

      if (!("choices" in chunk) || !Array.isArray(chunk.choices) || chunk.choices.length === 0) continue;

      if (chunk.choices.length > 1 && !warnedExtraChoices) {
        yield factory.responseWarning(
          "Delta Completions returned multiple choices; only the first array element is read. This adapter ignores choice.index.",
          WarningCode.MULTIPLE_CHOICES_IGNORED,
        );
        warnedExtraChoices = true;
      }

      const choice = chunk.choices[0];
      if (choice === null || typeof choice !== "object") continue;

      if ("finish_reason" in choice && typeof choice.finish_reason === "string" && choice.finish_reason) {
        lastFinishReason = choice.finish_reason;
      }

      if (!("delta" in choice) || choice.delta === null || typeof choice.delta !== "object") continue;
      const delta = choice.delta;

      if (
        !warnedIgnoredDelta &&
        ("tool_calls" in delta || "function_call" in delta || "reasoning" in delta || "reasoning_content" in delta)
      ) {
        yield factory.responseWarning(
          "Delta Completions ignored non-content delta fields (tool_calls / function_call / reasoning); use ChatCompletionsAdapter for those",
          WarningCode.CAPABILITY_DOWNGRADE,
        );
        warnedIgnoredDelta = true;
      }

      if (!("content" in delta) || typeof delta.content !== "string" || !delta.content) continue;

      const idSeed = responseId ?? request.requestId;
      yield* ensureMessageStarted(idSeed);
      accumulatedContent += delta.content;
      yield items.deltaMessage(currentMessageId, textBlock(delta.content));
    }
  }

  if (gate.completed) return;

  if (hasMessageStarted && items.isActive(currentMessageId)) {
    yield items.completeMessage(currentMessageId);
  }

  const stopReason: StopReason = lastFinishReason ? mapStopReason(lastFinishReason) : "end_turn";
  const assistantReplayMessage =
    accumulatedContent.length > 0 ? { role: "assistant" as const, content: accumulatedContent } : null;

  yield* finalizeStreamTurn(session, items, {
    stopReason,
    rawResponseId: responseId ?? request.requestId,
    factory,
    maxOpaquePayloadBytes: host.maxOpaquePayloadBytes,
    opaque: assistantReplayMessage
      ? opaqueItem(OPAQUE_SOURCE.DELTA_COMPLETIONS, "replay", {
          replaceCanonical: true,
          messages: [assistantReplayMessage],
        })
      : null,
  });
}
