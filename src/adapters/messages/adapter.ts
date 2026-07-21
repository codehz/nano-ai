/**
 * Messages Adapter
 *
 * 接入 Anthropic Messages API (messages 端点)。
 * 支持：
 * - 文本消息流 (text content block)
 * - 思维链流 (thinking content block)
 * - 工具调用流 (tool_use content block)
 * - 高保真 replay（含 opaque continuation）
 * - 能力降级 warning
 */

import { HttpAdapterBase } from "../../provider/http-adapter.js";
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
import { acceptOpaqueReplay } from "../../provider/opaque-replay.js";
import { usageFromAnthropicMessages } from "../../provider/usage/index.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";
import { createSseJsonParser } from "../../provider/transport/parser.js";
import {
  openProviderJsonStream,
  iterateProviderStreamBatches,
  createCompletionGate,
} from "../../provider/transport/open-stream.js";
import { mapMessagesThinking } from "../../provider/reasoning.js";

import type { NormalizedRequest, AIStreamEvent, OutputItem, ContentBlock } from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";

// ── 类型 ──────────────────────────────────────────────────────

import type {
  MessagesAdapterOptions,
  MessagesAPIRequest,
  MessagesAPIMessage,
  MessagesAPIContentBlock,
  MessagesAPITool,
} from "./types.js";

const mapper = new NormalizedRequestMapper("messages");

function isMessagesReplayContentBlock(value: unknown): value is MessagesAPIContentBlock {
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

function assertMessagesReplayContent(content: unknown): asserts content is MessagesAPIContentBlock[] {
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

type MessagesSSEEvent =
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

type MessagesAPIMessageResponse = {
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
function synthesizeItemId(kind: "msg" | "reason" | "reason-redacted", blockIndex: number, responseId: string): string {
  return `${kind}-${blockIndex}-${responseId}`;
}

function parseProviderToolUseInput(input: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Content block 映射 ─────────────────────────────────────────

function canonicalToMessagesBlock(b: ContentBlock): MessagesAPIContentBlock {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "json") return { type: "text", text: JSON.stringify(b.json) };
  throw new AIRequestError(
    `messages does not support content block type "${b.type}" in canonical mapping`,
    "UNSUPPORTED_CONTENT_BLOCK",
  );
}

function pickProviderHeaders(headers: Headers): Record<string, string> {
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

function buildStreamMetadata(options: {
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

// ── Adapter ───────────────────────────────────────────────────

export class MessagesAdapter extends HttpAdapterBase {
  readonly kind = "messages" as const;
  readonly isSyntheticStream = false;

  private apiVersion: string;

  constructor(options: MessagesAdapterOptions) {
    super(options, { baseUrl: "https://api.anthropic.com/v1" });
    this.apiVersion = options.apiVersion ?? "2023-06-01";
  }

  // ── buildRequest ──────────────────────────────────────────

  protected buildRequest(request: NormalizedRequest): MessagesAPIRequest {
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
          const payload = acceptOpaqueReplay(item, "messages");
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

    return this.withExtraBody(body);
  }

  // ── runStream ─────────────────────────────────────────────

  protected async *runStream(
    providerRequest: MessagesAPIRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    const auxiliary = this.createAuxiliaryState(request);
    const gate = createCompletionGate();

    if (request.metadata) {
      yield factory.responseWarning(
        "Request metadata is not supported by the Messages adapter",
        WarningCode.UNSUPPORTED_METADATA,
      );
    }

    const { reader, headers } = await openProviderJsonStream({
      fetchFn: this.fetchFn,
      url: `${this.baseUrl}/messages`,
      headers: this.mergeHeaders({
        "Content-Type": "application/json",
        "x-api-key": this.apiKey ?? "",
        "anthropic-version": this.apiVersion,
      }),
      body: providerRequest,
      signal: request.signal,
    });

    const parser = createSseJsonParser<MessagesSSEEvent>();
    const output: OutputItem[] = [];
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

    for await (const batch of iterateProviderStreamBatches({
      reader,
      parser,
      factory,
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
            yield factory.responseWarning(err.message, err.type);
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
                yield factory.messageStarted(currentItemId);
                break;
              }
              case "thinking": {
                currentItemType = "reasoning";
                currentItemId = synthesizeItemId("reason", currentContentBlockIndex, rawResponseId);
                currentThinkingVisibility = "full";
                thinkingBuffer = "";
                yield factory.reasoningStarted(currentItemId, "full");
                break;
              }
              case "redacted_thinking": {
                currentItemType = "reasoning";
                currentItemId = synthesizeItemId("reason-redacted", currentContentBlockIndex, rawResponseId);
                currentThinkingVisibility = "redacted";
                const data = (block as unknown as { data: string }).data;
                yield factory.reasoningStarted(currentItemId, "redacted");
                yield factory.reasoningDelta(currentItemId, textBlock(data));
                const redactedItem = reasoningItem([textBlock(data)], "redacted", currentItemId);
                yield factory.reasoningCompleted(currentItemId);
                output.push(redactedItem);
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
                yield factory.toolCallStarted(currentItemId, currentToolName);
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
                  yield factory.messageDelta(currentItemId, textBlock(txt));
                }
                break;
              }
              case "thinking_delta": {
                if (currentItemType === "reasoning" && currentItemId) {
                  const txt = (delta as unknown as { thinking: string }).thinking;
                  thinkingBuffer += txt;
                  yield factory.reasoningDelta(currentItemId, textBlock(txt));
                }
                break;
              }
              case "input_json_delta": {
                if (currentItemType === "tool_call" && currentItemId) {
                  const partial = (delta as unknown as { partial_json: string }).partial_json;
                  argsBuffer += partial;
                  yield factory.toolCallDelta(currentItemId, { argumentsText: partial });
                }
                break;
              }
            }
            continue;
          }

          case "content_block_stop": {
            if (currentItemType === "message" && currentItemId) {
              yield factory.messageCompleted(currentItemId);
              output.push(messageItem([textBlock(textBuffer)], { id: currentItemId }));
              rawReplayContent.push({ type: "text", text: textBuffer });
            } else if (currentItemType === "reasoning" && currentItemId && currentThinkingVisibility !== "redacted") {
              yield factory.reasoningCompleted(currentItemId);
              output.push(reasoningItem([textBlock(thinkingBuffer)], currentThinkingVisibility, currentItemId));
              rawReplayContent.push({ type: "thinking", thinking: thinkingBuffer });
            } else if (currentItemType === "tool_call" && currentItemId) {
              const tcItem = toolCallItem(currentItemId, currentToolName, argsBuffer);
              yield factory.toolCallCompleted(currentItemId);
              output.push(tcItem);
              rawReplayContent.push({
                type: "tool_use",
                id: currentItemId,
                name: currentToolName,
                input: parseProviderToolUseInput(argsBuffer),
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

    const replay = [...replayFromOutput(output)];

    if (messageResponse) {
      const replayContent = rawReplayContent.length > 0 ? rawReplayContent : messageResponse.content;
      replay.push(
        opaqueItem("messages", "replay", {
          replaceCanonical: true,
          role: messageResponse.role,
          content: replayContent,
          messageId: messageResponse.id,
          stopReason: stopReason ?? messageResponse.stop_reason,
        }),
      );
    }

    if (request.include?.providerMetadata !== "off") {
      auxiliary.recordProviderMetadata(
        "stream",
        buildStreamMetadata({
          apiVersion: this.apiVersion,
          message: messageResponse,
          stopReason,
          stopSequence,
        }),
      );
    }

    if (gate.tryComplete()) {
      yield* this.emitStreamCompleted(factory, request, auxiliary, {
        output,
        replay,
        stopReason: stopReason ? mapStopReason(stopReason) : undefined,
        rawResponseId,
      });
    }
  }
}
