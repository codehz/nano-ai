/**
 * MessagesAdapter — request 映射
 */

import { AIRequestError } from "../../runtime/errors.js";
import { contentBlocksToText } from "../../canonical/index.js";
import { acceptOpaqueReplay } from "../../provider/opaque-replay.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";
import { mapMessagesThinking } from "../../provider/reasoning.js";
import { OPAQUE_SOURCE } from "../../provider/opaque-sources.js";

import type { NormalizedRequest, ContentBlock } from "../../types/index.js";
import type {
  MessagesAPIRequest,
  MessagesAPIMessage,
  MessagesAPIContentBlock,
  MessagesAPITool,
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


export function buildMessagesRequest(request: NormalizedRequest): MessagesAPIRequest {
  mapper.assertNoServerTools(request.serverTools);

  const messages: MessagesAPIMessage[] = [];
  let systemPrompt: string | undefined;
  let pendingToolResultMessage: MessagesAPIMessage | undefined;

  // 处理 instructions → system prompt
  if (request.instructions) {
    systemPrompt = mapper.mapInstructions(request.instructions);
  }

  // 处理 input items
  for (const item of request.input) {
    if (item.type !== "tool_result") {
      pendingToolResultMessage = undefined;
    }

    switch (item.type) {
      case "message": {
        const role = item.role === "user" ? "user" : "assistant";
        const supportedContent = mapper.ensureTextBlocks(item.content, `input message (${item.role}) content`);
        if (supportedContent.length === 1 && supportedContent[0]?.type === "text") {
          messages.push({ role, content: supportedContent[0].text });
        } else {
          messages.push({ role, content: supportedContent.map(canonicalToMessagesBlock) });
        }
        break;
      }
      case "tool_call": {
        // Anthropic 使用 tool_use block 在 assistant message 中
        const lastMsg = messages[messages.length - 1];
        const toolBlock: MessagesAPIContentBlock = {
          type: "tool_use",
          id: item.id,
          name: item.name,
          input: mapper.parseToolArguments(item),
        };

        if (lastMsg && lastMsg.role === "assistant" && typeof lastMsg.content !== "string") {
          lastMsg.content.push(toolBlock);
        } else {
          messages.push({ role: "assistant", content: [toolBlock] });
        }
        break;
      }
      case "tool_result": {
        const content = mapper.textFromBlocks(item.content, `tool_result ${item.callId} content`);
        const block: MessagesAPIContentBlock = {
          type: "tool_result",
          tool_use_id: item.callId,
          content,
          is_error: item.outcome !== "success",
        };
        if (pendingToolResultMessage && typeof pendingToolResultMessage.content !== "string") {
          pendingToolResultMessage.content.push(block);
        } else {
          pendingToolResultMessage = { role: "user", content: [block] };
          messages.push(pendingToolResultMessage);
        }
        break;
      }
      case "reasoning": {
        // 将 reasoning item 转为 thinking block 在 assistant message 中
        const text = contentBlocksToText(mapper.ensureReasoningBlocks(item.content, "reasoning content"));
        const block: MessagesAPIContentBlock = { type: "thinking", thinking: text };
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === "assistant" && typeof lastMsg.content !== "string") {
          lastMsg.content.push(block);
        } else {
          messages.push({ role: "assistant", content: [block] });
        }
        break;
      }
      case "opaque": {
        // assistant opaque 始终 replace 尾部（与 replaceCanonical 语义一致）
        const payload = acceptOpaqueReplay(item, OPAQUE_SOURCE.MESSAGES);
        if (!payload) break;
        if (payload.role === "assistant" && "content" in payload) {
          assertMessagesReplayContent(payload.content);
          mapper.rollbackTrailingAssistantMessages(messages);
          messages.push({
            role: "assistant",
            content: payload.content,
          });
        }
        break;
      }
    }
  }

  const body: MessagesAPIRequest = {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? 4096,
    messages,
    stream: true,
  };

  if (systemPrompt) body.system = systemPrompt;

  body.tools = mapper.mapToolsIfPresent(
    request.tools,
    (t): MessagesAPITool => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }),
  );

  body.tool_choice = mapper.mapToolChoice<Exclude<MessagesAPIRequest["tool_choice"], undefined>>(request.toolChoice, {
    auto: { type: "auto" } as const,
    none: { type: "none" } as const,
    tool: (name) => ({ type: "tool" as const, name }),
  });

  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.reasoningLevel !== undefined) {
    body.thinking = mapMessagesThinking(request.reasoningLevel, body.max_tokens);
  }

  return body;
}
