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
import { AuxiliaryCollector } from "../helpers/auxiliary-collector.js";
import {
  textBlock,
  messageItem,
  reasoningItem,
  toolCallItem,
  opaqueItem,
  replayFromOutput,
  mapStopReason,
  blockToText,
  instructionsToText,
  contentBlocksToText,
} from "../helpers/mapping.js";

import { parseSSEEvents } from "../helpers/sse-parser.js";

import { CAPABILITY_MATRIX } from "../index.js";
import type { NormalizedRequest, AIStreamEvent, EventFactory, OutputItem, Usage, FetchFn } from "../index.js";

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

function parseMessagesSSE(chunk: string): { events: MessagesSSEEvent[]; rest: string } {
  const result = parseSSEEvents(chunk);
  return { events: result.events as MessagesSSEEvent[], rest: result.rest };
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
  if (b.type === "image") return { type: "text", text: `[Image: ${b.imageUrl}]` };
  if (b.type === "json") return { type: "text", text: JSON.stringify(b.json) };
  return { type: "text", text: "" };
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
  readonly capabilities = CAPABILITY_MATRIX.messages;

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
      systemPrompt = instructionsToText(request.instructions);
    }

    // 处理 input items
    for (const item of request.input) {
      switch (item.type) {
        case "message": {
          if (item.role === "system" || item.role === "developer") {
            // Anthropic 不支持 system/developer role 在 messages 中
            // 合并到 system prompt
            const text = contentBlocksToText(item.content);
            systemPrompt = systemPrompt ? `${systemPrompt}\n${text}` : text;
            break;
          }

          const role = item.role === "user" ? "user" : "assistant";
          if (item.content.length === 1 && item.content[0]?.type === "text") {
            messages.push({ role, content: item.content[0].text });
          } else {
            messages.push({ role, content: item.content.map(canonicalToMessagesBlock) });
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
            input:
              (item.argumentsJson as Record<string, unknown> | undefined) ??
              parseToolUseInput(item.argumentsText),
          };

          if (lastMsg && lastMsg.role === "assistant" && typeof lastMsg.content !== "string") {
            lastMsg.content.push(toolBlock);
          } else {
            messages.push({ role: "assistant", content: [toolBlock] });
          }
          break;
        }
        case "tool_result": {
          const content = item.content.map(blockToText).join("\n");
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
          const text = contentBlocksToText(item.content);
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
                  (b.type === "text" || b.type === "thinking" || b.type === "redacted_thinking" || b.type === "tool_use" || b.type === "tool_result"),
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
    const auxiliary = new AuxiliaryCollector();
    const metadataSources = new Set<string>();
    const rawReplayContent: MessagesAPIContentBlock[] = [];

    // 内容块累积缓冲
    let textBuffer = "";
    let thinkingBuffer = "";
    let argsBuffer = "";

    // 完成响应数据
    let stopReason: string | undefined;
    let stopSequence: string | null | undefined;
    let usage: Usage | undefined;
    let rawResponseId: string | undefined;

    if (request.include?.providerMetadata !== "off") {
      const headerMetadata = pickProviderHeaders(response.headers);
      if (Object.keys(headerMetadata).length > 0) {
        auxiliary.recordMetadata({ headers: headerMetadata });
        metadataSources.add("header");
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseMessagesSSE(buffer);
        buffer = rest;

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
              if (u && request.include?.usage !== "off") {
                usage = {
                  inputTokens: u.input_tokens,
                  outputTokens: u.output_tokens,
                  totalTokens: u.input_tokens + u.output_tokens,
                };
                auxiliary.recordUsage(usage, "stream", u);
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
      auxiliary.recordMetadata(
        buildStreamMetadata({
          apiVersion: this.apiVersion,
          message: messageResponse,
          stopReason,
          stopSequence,
        }),
      );
      metadataSources.add("stream");
    }

    // 警告低 replay fidelity
    if (!hasStreamedReasoning) {
      // 没有 reasoning，replay fidelity 较低
    }

    const auxiliaryResult = auxiliary.build();

    yield factory.responseCompleted(
      this.buildResponse(
        request,
        {
          output,
          replay,
          stopReason: stopReason ? mapStopReason(stopReason) : undefined,
          usage: auxiliaryResult.usage ?? usage,
          auxiliary: auxiliaryResult.auxiliary,
          metadataSources: metadataSources.size > 0 ? [...metadataSources] : undefined,
          rawResponseId,
        },
        factory,
      ),
    );
  }
}
