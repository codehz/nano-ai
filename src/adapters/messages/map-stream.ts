/**
 * MessagesAdapter — stream 映射
 */

import { AIRequestError, WarningCode } from "../../runtime/errors.js";
import {
  textBlock,
  opaqueItem,
  mapStopReason,
} from "../../canonical/index.js";
import { usageFromAnthropicMessages } from "../../provider/usage/index.js";
import { createSseJsonParser } from "../../provider/transport/parser.js";
import { createStreamingItemSession } from "../../provider/streaming-item-session.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";
import { parseJsonLooseObject } from "../../provider/json-parse.js";
import { finalizeStreamTurn } from "../../provider/finalize-stream-turn.js";
import { OPAQUE_SOURCE } from "../../provider/opaque-sources.js";

import type { NormalizedRequest, AIStreamEvent, ContentBlock } from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import type {
  MessagesAPIRequest,
  MessagesAPIContentBlock,
} from "./types.js";


export const mapper = new NormalizedRequestMapper("messages");

export function isMessagesReplayContentBlock(value: unknown): value is MessagesAPIContentBlock {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const block = value as Record<string, unknown>;
  switch (block.type) {
    case "text":
      return typeof block.text === "string";
    case "thinking":
      return (
        typeof block.thinking === "string" && (block.signature === undefined || typeof block.signature === "string")
      );
    case "redacted_thinking":
      return typeof block.data === "string";
    case "tool_use":
      return (
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        !!block.input &&
        typeof block.input === "object" &&
        !Array.isArray(block.input)
      );
    case "tool_result": {
      if (typeof block.tool_use_id !== "string") return false;
      if (block.is_error !== undefined && typeof block.is_error !== "boolean") return false;
      if (typeof block.content === "string") return true;
      if (!Array.isArray(block.content)) return false;
      return block.content.every(isMessagesReplayContentBlock);
    }
    default:
      return false;
  }
}

export function assertMessagesReplayContent(content: unknown): asserts content is MessagesAPIContentBlock[] {
  if (!Array.isArray(content)) {
    throw new AIRequestError("Invalid opaque replay payload: content must be an array", "INVALID_OPAQUE_REPLAY");
  }
  for (let i = 0; i < content.length; i++) {
    if (!isMessagesReplayContentBlock(content[i])) {
      throw new AIRequestError(
        `Invalid opaque replay payload: content[${i}] is not a valid Messages content block`,
        "INVALID_OPAQUE_REPLAY",
      );
    }
  }
}

// ── SSE 事件类型 ──────────────────────────────────────────────

export type MessagesSSEEvent =
  | { type: "message_start"; data: { message: MessagesAPIMessageResponse } }
  | { type: "content_block_start"; data: { index: number; content_block: { type: string; [key: string]: unknown } } }
  | { type: "content_block_delta"; data: { index: number; delta: { type: string; [key: string]: unknown } } }
  | { type: "content_block_stop"; data: { index: number } }
  | {
      type: "message_delta";
      data: {
        delta: { stop_reason?: string; stop_sequence?: string | null };
        usage: {
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
    }
  | { type: "message_stop"; data: Record<string, never> }
  | { type: "ping"; data: Record<string, never> }
  | { type: "error"; data: { error: { type: string; message: string } } };

export type MessagesAPIMessageResponse = {
  id: string;
  type: string;
  role: "assistant";
  model: string;
  content: MessagesAPIContentBlock[];
  stop_reason?: "end_turn" | "max_tokens" | "tool_use" | string;
  stop_sequence?: string | null;
  usage: { input_tokens: number; output_tokens: number };
};

/** 用 response 级别的命名空间合成 content block 的 item ID，避免多轮工具循环 ID 碰撞 */
export function synthesizeItemId(kind: "msg" | "reason" | "reason-redacted", blockIndex: number, responseId: string): string {
  return `${kind}-${blockIndex}-${responseId}`;
}


// ── Content block 映射 ─────────────────────────────────────────

export function canonicalToMessagesBlock(b: ContentBlock): MessagesAPIContentBlock {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "json") return { type: "text", text: JSON.stringify(b.json) };
  throw new AIRequestError(
    `messages does not support content block type "${b.type}" in canonical mapping`,
    "UNSUPPORTED_CONTENT_BLOCK",
  );
}

export function pickProviderHeaders(headers: Headers): Record<string, string> {
  const metadata: Record<string, string> = {};

  headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === "request-id" ||
      normalizedKey === "x-request-id" ||
      normalizedKey === "anthropic-organization-id" ||
      normalizedKey === "anthropic-beta" ||
      normalizedKey === "retry-after" ||
      normalizedKey.startsWith("anthropic-ratelimit-")
    ) {
      metadata[normalizedKey] = value;
    }
  });

  return metadata;
}

export function buildStreamMetadata(options: {
  apiVersion: string;
  message?: MessagesAPIMessageResponse;
  stopReason?: string;
  stopSequence?: string | null;
}): Record<string, unknown> {
  const { apiVersion, message, stopReason, stopSequence } = options;
  const metadata: Record<string, unknown> = {
    apiVersion,
  };

  if (message) {
    metadata.message = {
      id: message.id,
      type: message.type,
      role: message.role,
      model: message.model,
    };
  }

  if (stopReason !== undefined || stopSequence !== undefined) {
    metadata.stop = {
      reason: stopReason,
      sequence: stopSequence,
    };
  }

  return metadata;
}


export type MessagesAdapterStreamHost = {
  beginJsonStream: (
    factory: EventFactory,
    request: NormalizedRequest,
  ) => import("../../provider/transport/run-json-stream.js").ProviderJsonStreamSession;
  baseUrl: string;
  apiKey?: string;
  mergeHeaders: (headers: Record<string, string>) => Record<string, string>;
  apiVersion: string;
};

export async function* mapMessagesStream(
  host: MessagesAdapterStreamHost,
  providerRequest: MessagesAPIRequest,
  factory: EventFactory,
  request: NormalizedRequest,
): AsyncIterable<AIStreamEvent> {
  const session = host.beginJsonStream(factory, request);
  const { auxiliary } = session;

  if (request.metadata) {
    yield factory.responseWarning(
      "Request metadata is not supported by the Messages adapter",
      WarningCode.UNSUPPORTED_METADATA,
    );
  }

  const { headers } = await session.open({
    url: `${host.baseUrl}/messages`,
    headers: host.mergeHeaders({
      "Content-Type": "application/json",
      "x-api-key": host.apiKey ?? "",
      "anthropic-version": host.apiVersion,
    }),
    body: providerRequest,
  });

  const parser = createSseJsonParser<MessagesSSEEvent>();
  const items = createStreamingItemSession(factory);
  let messageResponse: MessagesAPIMessageResponse | undefined;
  let currentContentBlockIndex = -1;
  let currentItemType: "message" | "reasoning" | "tool_call" | null = null;
  let currentItemId = "";
  let currentToolName = "";
  let currentThinkingVisibility: "full" | "redacted" = "full";
  const rawReplayContent: MessagesAPIContentBlock[] = [];

  let textBuffer = "";
  let thinkingBuffer = "";
  let argsBuffer = "";

  let stopReason: string | undefined;
  let stopSequence: string | null | undefined;
  let rawResponseId = "";

  if (request.include?.providerMetadata !== "off") {
    const headerMetadata = pickProviderHeaders(headers);
    auxiliary.recordProviderMetadata(
      "header",
      Object.keys(headerMetadata).length > 0 ? { headers: headerMetadata } : undefined,
    );
  }

  for await (const batch of session.batches({
    parser,
    providerLabel: "Messages",
    transportLabel: "SSE event(s)",
    incompleteMessage: "Stream ended with an incomplete Messages SSE frame",
  })) {
    for (const warning of batch.warnings) yield warning;

    for (const sseEvent of batch.items) {
      switch (sseEvent.type) {
        case "ping":
          continue;

        case "error": {
          const err = sseEvent.data.error;
          // provider 自定义 err.type 不进入 WarningCode；统一记 PROVIDER_FAILURE，原文保留在 message
          yield factory.responseWarning(
            err.type ? `${err.type}: ${err.message}` : err.message,
            WarningCode.PROVIDER_FAILURE,
          );
          continue;
        }

        case "message_start": {
          messageResponse = sseEvent.data.message;
          rawResponseId = messageResponse.id;
          continue;
        }

        case "content_block_start": {
          const block = sseEvent.data.content_block;
          currentContentBlockIndex = sseEvent.data.index;

          switch (block.type) {
            case "text": {
              currentItemType = "message";
              currentItemId = synthesizeItemId("msg", currentContentBlockIndex, rawResponseId);
              textBuffer = "";
              yield items.startMessage(currentItemId);
              break;
            }
            case "thinking": {
              currentItemType = "reasoning";
              currentItemId = synthesizeItemId("reason", currentContentBlockIndex, rawResponseId);
              currentThinkingVisibility = "full";
              thinkingBuffer = "";
              yield items.startReasoning(currentItemId, "full");
              break;
            }
            case "redacted_thinking": {
              currentItemType = "reasoning";
              currentItemId = synthesizeItemId("reason-redacted", currentContentBlockIndex, rawResponseId);
              currentThinkingVisibility = "redacted";
              const data = (block as unknown as { data: string }).data;
              yield items.startReasoning(currentItemId, "redacted");
              yield items.deltaReasoning(currentItemId, textBlock(data));
              yield items.completeReasoning(currentItemId);
              rawReplayContent.push({ type: "redacted_thinking", data });
              currentItemType = null;
              break;
            }
            case "tool_use": {
              const tuBlock = block as unknown as { id: string; name: string };
              currentItemType = "tool_call";
              currentItemId = tuBlock.id;
              currentToolName = tuBlock.name;
              argsBuffer = "";
              yield items.startToolCall(currentItemId, currentToolName);
              break;
            }
          }
          continue;
        }

        case "content_block_delta": {
          const delta = sseEvent.data.delta;

          switch (delta.type) {
            case "text_delta": {
              if (currentItemType === "message" && currentItemId) {
                const txt = (delta as unknown as { text: string }).text;
                textBuffer += txt;
                yield items.deltaMessage(currentItemId, textBlock(txt));
              }
              break;
            }
            case "thinking_delta": {
              if (currentItemType === "reasoning" && currentItemId) {
                const txt = (delta as unknown as { thinking: string }).thinking;
                thinkingBuffer += txt;
                yield items.deltaReasoning(currentItemId, textBlock(txt));
              }
              break;
            }
            case "input_json_delta": {
              if (currentItemType === "tool_call" && currentItemId) {
                const partial = (delta as unknown as { partial_json: string }).partial_json;
                argsBuffer += partial;
                yield items.deltaToolCall(currentItemId, { argumentsText: partial });
              }
              break;
            }
          }
          continue;
        }

        case "content_block_stop": {
          if (currentItemType === "message" && currentItemId) {
            yield items.completeMessage(currentItemId);
            rawReplayContent.push({ type: "text", text: textBuffer });
          } else if (currentItemType === "reasoning" && currentItemId && currentThinkingVisibility !== "redacted") {
            yield items.completeReasoning(currentItemId);
            rawReplayContent.push({ type: "thinking", thinking: thinkingBuffer });
          } else if (currentItemType === "tool_call" && currentItemId) {
            yield items.completeToolCall(currentItemId);
            rawReplayContent.push({
              type: "tool_use",
              id: currentItemId,
              name: currentToolName,
              input: parseJsonLooseObject(argsBuffer),
            });
          }

          currentItemType = null;
          currentItemId = "";
          continue;
        }

        case "message_delta": {
          stopReason = sseEvent.data.delta.stop_reason;
          stopSequence = sseEvent.data.delta.stop_sequence;
          const u = sseEvent.data.usage;
          if (u) {
            auxiliary.recordUsage(usageFromAnthropicMessages(u), "stream", u);
          }
          continue;
        }

        case "message_stop": {
          break;
        }
      }
    }
  }

  if (request.include?.providerMetadata !== "off") {
    auxiliary.recordProviderMetadata(
      "stream",
      buildStreamMetadata({
        apiVersion: host.apiVersion,
        message: messageResponse,
        stopReason,
        stopSequence,
      }),
    );
  }

  const opaque = messageResponse
    ? opaqueItem(OPAQUE_SOURCE.MESSAGES, "replay", {
        replaceCanonical: true,
        role: messageResponse.role,
        content: rawReplayContent.length > 0 ? rawReplayContent : messageResponse.content,
        messageId: messageResponse.id,
        stopReason: stopReason ?? messageResponse.stop_reason,
      })
    : null;

  yield* finalizeStreamTurn(
    session,
    items,
    {
      opaque,
      stopReason: stopReason ? mapStopReason(stopReason) : undefined,
      rawResponseId,
      onDuplicate: "silent",
    },
  );
}
