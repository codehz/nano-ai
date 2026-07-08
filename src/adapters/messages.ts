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

import { AdapterBase } from "../helpers/adapter-base.js";
import { AIRequestError } from "../core/errors.js";
import {
  textBlock,
  messageItem,
  reasoningItem,
  toolCallItem,
  opaqueItem,
  replayFromOutput,
  mapStopReason,
  blockToText,
  contentBlocksToText,
} from "../helpers/mapping.js";
import { emitMalformedStreamWarning } from "../helpers/adapter-auxiliary.js";

import { parseSSEEvents } from "../helpers/sse-parser.js";

import type { NormalizedRequest, AIStreamEvent, EventFactory, OutputItem, FetchFn } from "../index.js";

// ── 类型 ──────────────────────────────────────────────────────

export type MessagesAdapterOptions = {
  apiKey: string;
  apiVersion?: string;
  baseUrl?: string;
  /** 可注入自定义 fetch 实现（用于测试／代理） */
  fetch?: FetchFn;
};

// ── Messages API 请求类型 ────────────────────────────────────

type MessagesAPIRequest = {
  model: string;
  max_tokens: number;
  messages: MessagesAPIMessage[];
  system?: string;
  tools?: MessagesAPITool[];
  tool_choice?: { type: "auto" | "none" } | { type: "tool"; name: string };
  temperature?: number;
  thinking?: { type: "enabled"; budget_tokens: number };
  stream: true;
};

type MessagesAPIMessage = {
  role: "user" | "assistant";
  content: string | MessagesAPIContentBlock[];
};

type MessagesAPIContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | MessagesAPIContentBlock[]; is_error?: boolean };

type MessagesAPITool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

function ensureMessagesTextBlocks(
  blocks: import("../index.js").ContentBlock[],
  field: string,
): import("../index.js").ContentBlock[] {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;
    if (block.type !== "text" && block.type !== "json") {
      throw new AIRequestError(
        `messages does not support ${field}[${i}] of type "${block.type}"; only text/json blocks are supported`,
        "UNSUPPORTED_CONTENT_BLOCK",
      );
    }
  }

  return blocks;
}

function ensureMessagesReasoningBlocks(
  blocks: import("../index.js").ContentBlock[],
  field: string,
): Array<Extract<import("../index.js").ContentBlock, { type: "text" }>> {
  return blocks.map((block, index) => {
    if (block.type !== "text") {
      throw new AIRequestError(
        `messages does not support ${field}[${index}] of type "${block.type}"; reasoning only supports text blocks`,
        "UNSUPPORTED_CONTENT_BLOCK",
      );
    }

    return block;
  });
}

function instructionsToMessagesText(instructions: string | import("../index.js").InstructionBlock[]): string {
  return typeof instructions === "string"
    ? instructions
    : contentBlocksToText(ensureMessagesTextBlocks(instructions, "instructions"));
}

function assertMessagesToolResultOutcome(outcome: import("../index.js").ToolResultItem["outcome"]): void {
  if (outcome === "rejected") {
    throw new AIRequestError(
      'messages does not preserve tool_result outcome "rejected"; only "success" and "error" are supported',
      "UNSUPPORTED_TOOL_RESULT_OUTCOME",
    );
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
        usage: { input_tokens: number; output_tokens: number };
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

// ── SSE 解析 ──────────────────────────────────────────────────

function parseMessagesSSE(chunk: string): { events: MessagesSSEEvent[]; rest: string; malformedEvents: number } {
  const result = parseSSEEvents(chunk);
  return { events: result.events as MessagesSSEEvent[], rest: result.rest, malformedEvents: result.malformedEvents };
}

function rollbackTrailingAssistantMessages(messages: MessagesAPIMessage[]): void {
  while (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
    messages.pop();
  }
}

function parseToolUseInput(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Content block 映射 ─────────────────────────────────────────

function canonicalToMessagesBlock(b: import("../index.js").ContentBlock): MessagesAPIContentBlock {
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

export class MessagesAdapter extends AdapterBase {
  readonly kind = "messages" as const;
  readonly nativeStreaming = true;

  private apiKey: string;
  private apiVersion: string;
  private baseUrl: string;
  private fetchFn: FetchFn;
  private warningAccumulator: string[];

  constructor(options: MessagesAdapterOptions) {
    super();
    this.apiKey = options.apiKey;
    this.apiVersion = options.apiVersion ?? "2023-06-01";
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com/v1";
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.warningAccumulator = [];
  }

  protected warn(message: string, _code?: string): void {
    this.warningAccumulator.push(message);
  }

  // ── buildRequest ──────────────────────────────────────────

  protected buildRequest(request: NormalizedRequest): MessagesAPIRequest {
    const messages: MessagesAPIMessage[] = [];
    let systemPrompt: string | undefined;

    // 处理 instructions → system prompt
    if (request.instructions) {
      systemPrompt = instructionsToMessagesText(request.instructions);
    }

    // 处理 input items
    for (const item of request.input) {
      switch (item.type) {
        case "message": {
          const role = item.role === "user" ? "user" : "assistant";
          const supportedContent = ensureMessagesTextBlocks(item.content, `input message (${item.role}) content`);
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
            input: (item.argumentsJson as Record<string, unknown> | undefined) ?? parseToolUseInput(item.argumentsText),
          };

          if (lastMsg && lastMsg.role === "assistant" && typeof lastMsg.content !== "string") {
            lastMsg.content.push(toolBlock);
          } else {
            messages.push({ role: "assistant", content: [toolBlock] });
          }
          break;
        }
        case "tool_result": {
          assertMessagesToolResultOutcome(item.outcome);
          const content = ensureMessagesTextBlocks(item.content, `tool_result ${item.callId} content`)
            .map(blockToText)
            .join("\n");
          const block: MessagesAPIContentBlock = {
            type: "tool_result",
            tool_use_id: item.callId,
            content,
            is_error: item.outcome === "error",
          };
          messages.push({ role: "user", content: [block] });
          break;
        }
        case "reasoning": {
          // 将 reasoning item 转为 thinking block 在 assistant message 中
          const text = contentBlocksToText(ensureMessagesReasoningBlocks(item.content, "reasoning content"));
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
          // 尝试从 opaque replay item 中提取 assistant message
          if (item.purpose === "replay" && typeof item.payload === "object" && item.payload !== null) {
            const payload = item.payload as Record<string, unknown>;
            if (payload.role === "assistant" && Array.isArray(payload.content)) {
              // 验证 content 是合法的 MessagesAPIContentBlock[]
              const isValidContent = payload.content.every(
                (b): b is MessagesAPIContentBlock =>
                  typeof b === "object" &&
                  b !== null &&
                  "type" in b &&
                  (b.type === "text" ||
                    b.type === "thinking" ||
                    b.type === "redacted_thinking" ||
                    b.type === "tool_use" ||
                    b.type === "tool_result"),
              );
              if (isValidContent) {
                rollbackTrailingAssistantMessages(messages);
                messages.push({
                  role: "assistant",
                  content: payload.content as MessagesAPIContentBlock[],
                });
              }
            }
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

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(
        (t): MessagesAPITool => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        }),
      );
    }

    if (request.toolChoice) {
      if (request.toolChoice === "auto") body.tool_choice = { type: "auto" };
      else if (request.toolChoice === "none") body.tool_choice = { type: "none" };
      else if (request.toolChoice.type === "tool") {
        body.tool_choice = { type: "tool", name: request.toolChoice.name };
      }
    }

    if (request.temperature !== undefined) body.temperature = request.temperature;

    return body;
  }

  // ── runStream ─────────────────────────────────────────────

  protected async *runStream(
    providerRequest: MessagesAPIRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    this.warningAccumulator = [];
    const auxiliary = this.createAuxiliaryState(request);

    if (request.metadata) {
      yield factory.responseWarning(
        "Request metadata is not supported by the Messages adapter",
        "UNSUPPORTED_METADATA",
      );
    }

    const response = await this.fetchFn(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.apiVersion,
      },
      body: JSON.stringify(providerRequest),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`Messages API error ${response.status}: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Response body is not readable");
    }

    // 流累积状态
    const output: OutputItem[] = [];
    const decoder = new TextDecoder();
    let buffer = "";
    let messageResponse: MessagesAPIMessageResponse | undefined;
    let currentContentBlockIndex = -1;
    let currentItemType: "message" | "reasoning" | "tool_call" | null = null;
    let currentItemId = "";
    let currentToolName = "";
    let currentArgsText = "";
    let currentThinkingVisibility: "full" | "redacted" = "full";
    let hasStreamedReasoning = false;
    const rawReplayContent: MessagesAPIContentBlock[] = [];

    // 内容块累积缓冲
    let textBuffer = "";
    let thinkingBuffer = "";
    let argsBuffer = "";

    // 完成响应数据
    let stopReason: string | undefined;
    let stopSequence: string | null | undefined;
    let rawResponseId: string | undefined;

    if (request.include?.providerMetadata !== "off") {
      const headerMetadata = pickProviderHeaders(response.headers);
      auxiliary.recordProviderMetadata(
        "header",
        Object.keys(headerMetadata).length > 0 ? { headers: headerMetadata } : undefined,
      );
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { events, rest, malformedEvents } = parseMessagesSSE(buffer);
        buffer = rest;

        const malformedWarning = emitMalformedStreamWarning(factory, {
          count: malformedEvents,
          providerLabel: "Messages",
          transportLabel: "SSE event(s)",
        });
        if (malformedWarning) {
          yield malformedWarning;
        }

        for (const sseEvent of events) {
          switch (sseEvent.type) {
            case "ping":
              continue;

            case "error": {
              const err = sseEvent.data.error;
              yield factory.responseWarning(err.message, err.type);
              this.warn(err.message, err.type);
              continue;
            }

            case "message_start": {
              messageResponse = sseEvent.data.message;
              rawResponseId = messageResponse.id;
              // 检查是否有 thinking 能力
              if (messageResponse.content.some((b) => b.type === "thinking" || b.type === "redacted_thinking")) {
                hasStreamedReasoning = true;
              }
              continue;
            }

            case "content_block_start": {
              const block = sseEvent.data.content_block;
              currentContentBlockIndex = sseEvent.data.index;

              switch (block.type) {
                case "text": {
                  currentItemType = "message";
                  currentItemId = `msg-${block.type}-${currentContentBlockIndex}`;
                  textBuffer = "";
                  yield factory.messageStarted(currentItemId);
                  break;
                }
                case "thinking": {
                  hasStreamedReasoning = true;
                  currentItemType = "reasoning";
                  currentItemId = `reason-${currentContentBlockIndex}`;
                  currentThinkingVisibility = "full";
                  thinkingBuffer = "";
                  yield factory.reasoningStarted(currentItemId, "full");
                  break;
                }
                case "redacted_thinking": {
                  hasStreamedReasoning = true;
                  currentItemType = "reasoning";
                  currentItemId = `reason-redacted-${currentContentBlockIndex}`;
                  currentThinkingVisibility = "redacted";
                  const data = (block as unknown as { data: string }).data;
                  yield factory.reasoningStarted(currentItemId, "redacted");
                  yield factory.reasoningDelta(currentItemId, textBlock(data));
                  const redactedItem = reasoningItem([textBlock(data)], "redacted", currentItemId);
                  yield factory.reasoningCompleted(redactedItem);
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
                  currentArgsText = "";
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
                    yield factory.messageDelta(currentItemId, txt);
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
                yield factory.messageCompleted(messageItem([textBlock(textBuffer)], { id: currentItemId }));
                output.push(messageItem([textBlock(textBuffer)], { id: currentItemId }));
                rawReplayContent.push({ type: "text", text: textBuffer });
              } else if (currentItemType === "reasoning" && currentItemId && currentThinkingVisibility !== "redacted") {
                yield factory.reasoningCompleted(
                  reasoningItem([textBlock(thinkingBuffer)], currentThinkingVisibility, currentItemId),
                );
                output.push(reasoningItem([textBlock(thinkingBuffer)], currentThinkingVisibility, currentItemId));
                rawReplayContent.push({ type: "thinking", thinking: thinkingBuffer });
              } else if (currentItemType === "tool_call" && currentItemId) {
                const tcItem = toolCallItem(currentItemId, currentToolName, currentArgsText || argsBuffer);
                yield factory.toolCallCompleted(tcItem);
                output.push(tcItem);
                rawReplayContent.push({
                  type: "tool_use",
                  id: currentItemId,
                  name: currentToolName,
                  input: parseToolUseInput(currentArgsText || argsBuffer),
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
                auxiliary.recordUsage(
                  {
                    inputTokens: u.input_tokens,
                    outputTokens: u.output_tokens,
                    totalTokens: u.input_tokens + u.output_tokens,
                  },
                  "stream",
                  u,
                );
              }
              continue;
            }

            case "message_stop": {
              // 流结束，构造 final response
              break;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (buffer.trim().length > 0) {
      yield factory.responseWarning("Stream ended with an incomplete Messages SSE frame", "STREAM_ERROR");
    }

    // 构造 replay
    const replay = [...replayFromOutput(output)];

    // 附加 opaque replay item 用于续接
    // 保存 provider 原始 block 以实现高保真 replay
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

    // 警告低 replay fidelity
    if (!hasStreamedReasoning) {
      // 没有 reasoning，replay fidelity 较低
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
          stopReason: stopReason ? mapStopReason(stopReason) : undefined,
          usage: auxiliaryResult.usage,
          billing: auxiliaryResult.billing,
          auxiliary: auxiliaryResult.auxiliary,
          warnings: auxiliaryResult.warnings,
          metadataSources: auxiliaryResult.metadataSources,
          rawResponseId,
        },
        factory,
      ),
    );
  }
}
