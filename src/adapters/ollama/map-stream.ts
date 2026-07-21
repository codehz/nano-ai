/**
 * OllamaAdapter — stream 映射
 */

import { WarningCode } from "../../runtime/errors.js";
import {
  textBlock,
  opaqueItem,
  mapStopReason,
} from "../../canonical/index.js";
import { createStreamingItemSession } from "../../provider/streaming-item-session.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";
import { usageFromOllama } from "../../provider/usage/index.js";
import { createNdjsonLineParser } from "../../provider/transport/parser.js";
import { parseJsonLooseObject } from "../../provider/json-parse.js";
import { finalizeStreamTurn } from "../../provider/finalize-stream-turn.js";
import { OPAQUE_SOURCE } from "../../provider/opaque-sources.js";

import type { NormalizedRequest, AIStreamEvent, StopReason } from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import type { OllamaChatRequest, OllamaToolCall } from "./types.js";


export const mapper = new NormalizedRequestMapper("ollama");

// ── Ollama 流式 chunk ─────────────────────────────────────────

export type OllamaChatChunk = {
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
export type OllamaReplayToolCall = OllamaToolCall & { id?: string };

export function isOllamaReplayToolCalls(value: unknown): value is OllamaReplayToolCall[] {
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

export function toWireOllamaToolCalls(toolCalls: OllamaReplayToolCall[]): OllamaToolCall[] {
  return toolCalls.map((tc) => ({
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments,
    },
  }));
}



export type OllamaAdapterStreamHost = {
  beginJsonStream: (
    factory: EventFactory,
    request: NormalizedRequest,
  ) => import("../../provider/transport/run-json-stream.js").ProviderJsonStreamSession;
  baseUrl: string;
  apiKey?: string;
  mergeHeaders: (headers: Record<string, string>) => Record<string, string>;
  
};

export async function* mapOllamaStream(
  host: OllamaAdapterStreamHost,
  providerRequest: OllamaChatRequest,
  factory: EventFactory,
  request: NormalizedRequest,
): AsyncIterable<AIStreamEvent> {
  const session = host.beginJsonStream(factory, request);
  const { auxiliary, gate } = session;
  const items = createStreamingItemSession(factory);

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
  if (host.apiKey) {
    headers.Authorization = `Bearer ${host.apiKey}`;
  }

  await session.open({
    url: `${host.baseUrl}/api/chat`,
    headers: host.mergeHeaders(headers),
    body: providerRequest,
  });

  const parser = createNdjsonLineParser<OllamaChatChunk>(
    (value): value is OllamaChatChunk => !!value && typeof value === "object" && "message" in value,
  );

  // wire 缓冲仅用于 opaque；item 内容由 items session 维护
  let responseId: string | undefined;
  let accumulatedContent = "";
  let currentMessageId = "";
  let hasMessageStarted = false;
  let pendingToolCalls: Array<{ id: string; name: string; argumentsText: string }> = [];
  let toolCallIndex = 0;

  const ensureMessageStarted = function* (idSeed: string): Generator<AIStreamEvent> {
    if (!currentMessageId) currentMessageId = `msg-${idSeed}`;
    const started = items.ensureMessageStarted(currentMessageId);
    if (started) {
      hasMessageStarted = true;
      yield started;
    }
  };

  /** done / incomplete 共用：flush message + batched tool_calls */
  const flushPendingItems = function* (idSeed: string): Generator<AIStreamEvent> {
    if (accumulatedContent === "" && pendingToolCalls.length > 0 && !hasMessageStarted) {
      yield* ensureMessageStarted(idSeed);
    }

    // 已 start 的空 message 也 complete 进 session（事件权威）
    if (hasMessageStarted && items.isActive(currentMessageId)) {
      yield items.completeMessage(currentMessageId);
    }

    if (pendingToolCalls.length > 0) {
      yield factory.responseWarning(
        `Ollama delivered ${pendingToolCalls.length} tool call(s) as a batch; tool_call streaming is not supported`,
        WarningCode.TOOL_CALL_BATCHED,
      );
    }

    for (const pending of pendingToolCalls) {
      yield items.startToolCall(pending.id, pending.name);
      yield items.deltaToolCall(pending.id, { argumentsText: pending.argumentsText });
      yield items.completeToolCall(pending.id);
    }
  };

  const emitCompleted = async function* (
    stopReason: StopReason | undefined,
    rawResponseId: string | undefined,
  ): AsyncIterable<AIStreamEvent> {
    yield* finalizeStreamTurn(session, items, {
      stopReason,
      rawResponseId,
      opaque:
        accumulatedContent || pendingToolCalls.length > 0
          ? opaqueItem(OPAQUE_SOURCE.OLLAMA, "replay", {
              role: "assistant",
              content: accumulatedContent,
              tool_calls: pendingToolCalls.map((tc) => ({
                id: tc.id,
                function: { name: tc.name, arguments: parseJsonLooseObject(tc.argumentsText) },
              })),
            })
          : null,
    });
  };

  for await (const batch of session.batches({
    parser,
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
        yield* ensureMessageStarted(chunk.created_at);
        accumulatedContent += msg.content;
        yield items.deltaMessage(currentMessageId, textBlock(msg.content));
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
        yield* flushPendingItems(chunk.created_at);

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
    yield* flushPendingItems(responseId ?? request.requestId);
    yield* emitCompleted(undefined, responseId);
  }
}
