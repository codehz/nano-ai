/**
 * Responses Adapter
 *
 * 接入 OpenAI Responses API (responses 端点)。
 * 职责分层：
 *   1. buildRequest — 将 NormalizedRequest 转换为 Responses API 请求
 *   2. runStream     — 调用 API、解析 SSE、发射 canonical 事件
 *
 * 支持消息流 / reasoning 流 / tool_call 流及高保真 replay。
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
  blockToText,
  contentBlocksToText,
} from "../helpers/mapping.js";
import { emitMalformedStreamWarning } from "../helpers/adapter-auxiliary.js";

import { parseSSEEvents } from "../helpers/sse-parser.js";

import type { AdapterCapabilities, NormalizedRequest, AIStreamEvent, EventFactory, OutputItem, FetchFn } from "../index.js";

// ── 类型 ──────────────────────────────────────────────────────

export type ResponsesAdapterOptions = {
  apiKey: string;
  baseUrl?: string;
  /** 可注入自定义 fetch 实现（用于测试／代理） */
  fetch?: FetchFn;
};

// ── Responses API 请求类型 ────────────────────────────────────

type ResponsesAPIRequest = {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: "auto" | "none" | { type: "function"; name: string };
  metadata?: Record<string, string>;
  temperature?: number;
  max_output_tokens?: number;
  stream: true;
};

type ResponsesInputItem =
  | { type: "message"; role: "user" | "assistant" | "system" | "developer"; content: string }
  | { type: "message"; role: "assistant"; content: ResponsesContentBlock[] }
  | { type: "function_call"; id: string; name: string; arguments: string; call_id?: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; content: ResponsesContentBlock[] }
  | { type: "item_reference"; id: string };

type ResponsesContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "refusal"; refusal: string };

type ResponsesTool = {
  type: "function";
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

function ensureResponsesTextBlocks(
  blocks: import("../index.js").ContentBlock[],
  field: string,
): import("../index.js").ContentBlock[] {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;
    if (block.type !== "text" && block.type !== "json") {
      throw new AIRequestError(
        `responses does not support ${field}[${i}] of type "${block.type}"; only text/json blocks are supported`,
        "UNSUPPORTED_CONTENT_BLOCK",
      );
    }
  }

  return blocks;
}

function ensureResponsesReasoningBlocks(
  blocks: import("../index.js").ContentBlock[],
  field: string,
): Array<Extract<import("../index.js").ContentBlock, { type: "text" }>> {
  return blocks.map((block, index) => {
    if (block.type !== "text") {
      throw new AIRequestError(
        `responses does not support ${field}[${index}] of type "${block.type}"; reasoning only supports text blocks`,
        "UNSUPPORTED_CONTENT_BLOCK",
      );
    }

    return block;
  });
}

function instructionsToResponsesText(instructions: string | import("../index.js").ContentBlock[]): string {
  return typeof instructions === "string"
    ? instructions
    : contentBlocksToText(ensureResponsesTextBlocks(instructions, "instructions"));
}

function assertResponsesToolResultOutcome(outcome: import("../index.js").ToolResultItem["outcome"]): void {
  if (outcome !== "success") {
    throw new AIRequestError(
      `responses does not preserve tool_result outcome "${outcome}"; only "success" is supported`,
      "UNSUPPORTED_TOOL_RESULT_OUTCOME",
    );
  }
}

// ── SSE 事件类型 ──────────────────────────────────────────────

type ResponsesSSEEvent =
  | { type: "response.output_item.added"; data: { item: { id: string; type: string; [key: string]: unknown } } }
  | { type: "response.output_text.delta"; data: { item_id: string; delta: string } }
  | { type: "response.output_text.done"; data: { item_id: string; text: string } }
  | { type: "response.reasoning.delta"; data: { item_id: string; delta: string } }
  | { type: "response.reasoning.done"; data: { item_id: string; text: string } }
  | { type: "response.tool_call.delta"; data: { item_id: string; delta: { arguments?: string } } }
  | { type: "response.tool_call.done"; data: { item_id: string; arguments?: string; name?: string } }
  | { type: "response.completed"; data: { response: ResponsesAPIResponse } }
  | { type: "error"; data: { message: string; code?: string } };

type ResponsesAPIResponse = {
  id: string;
  model: string;
  output: ResponsesAPIOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type ResponsesAPIOutputItem = {
  id: string;
  type: "message" | "reasoning" | "function_call";
  role?: string;
  content?: ResponsesContentBlock[];
  name?: string;
  arguments?: string;
  status?: string;
};

// ── SSE 解析 ──────────────────────────────────────────────────

function parseSSE(chunk: string): { events: ResponsesSSEEvent[]; rest: string; malformedEvents: number } {
  const result = parseSSEEvents(chunk);
  return { events: result.events as ResponsesSSEEvent[], rest: result.rest, malformedEvents: result.malformedEvents };
}

function isReplayCanonicalInput(item: ResponsesInputItem): boolean {
  return (
    (item.type === "message" && item.role === "assistant") ||
    item.type === "reasoning" ||
    item.type === "function_call"
  );
}

function rollbackTrailingReplayCanonicalItems(input: ResponsesInputItem[]): void {
  while (input.length > 0) {
    const last = input[input.length - 1];
    if (!last || !isReplayCanonicalInput(last)) break;
    input.pop();
  }
}

// ── Content block 映射 ─────────────────────────────────────────

function canonicalToResponsesBlock(b: import("../index.js").ContentBlock): ResponsesContentBlock {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "json") return { type: "text", text: JSON.stringify(b.json) };
  throw new AIRequestError(
    `responses does not support content block type "${b.type}" in canonical mapping`,
    "UNSUPPORTED_CONTENT_BLOCK",
  );
}

// ── Adapter ───────────────────────────────────────────────────

export class ResponsesAdapter extends AdapterBase {
  readonly kind = "responses" as const;
  readonly capabilities: AdapterCapabilities = {
    nativeStreaming: true,
    messageStreaming: true,
    reasoningStreaming: true,
    toolCallStreaming: true,
    hiddenReasoningReplay: "full" as const,
    replayFidelity: "high" as const,
    tools: true,
    usage: "full" as const,
    billing: "lookup" as const,
    providerMetadata: true,
  };

  private apiKey: string;
  private baseUrl: string;
  private fetchFn: FetchFn;

  constructor(options: ResponsesAdapterOptions) {
    super();
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  // ── buildRequest ──────────────────────────────────────────

  protected buildRequest(request: NormalizedRequest): ResponsesAPIRequest {
    const input: ResponsesInputItem[] = [];

    for (const item of request.input) {
      switch (item.type) {
        case "message": {
          // Responses API 中只有 assistant 角色支持 content blocks
          if (item.role === "assistant") {
            const blocks = ensureResponsesTextBlocks(item.content, `assistant message (${item.role}) content`).map(
              canonicalToResponsesBlock,
            );
            input.push({ type: "message", role: item.role, content: blocks });
          } else {
            input.push({
              type: "message",
              role: item.role,
              content: contentBlocksToText(
                ensureResponsesTextBlocks(item.content, `input message (${item.role}) content`),
              ),
            });
          }
          break;
        }
        case "reasoning": {
          const blocks = ensureResponsesReasoningBlocks(item.content, "reasoning content").map(
            (b): ResponsesContentBlock => ({ type: "reasoning", text: b.text }),
          );
          input.push({ type: "reasoning", content: blocks });
          break;
        }
        case "tool_call": {
          input.push({
            type: "function_call",
            id: item.id,
            name: item.name,
            arguments: item.argumentsText,
          });
          break;
        }
        case "tool_result": {
          assertResponsesToolResultOutcome(item.outcome);
          const output = ensureResponsesTextBlocks(item.content, `tool_result ${item.callId} content`)
            .map(blockToText)
            .join("\n");
          input.push({
            type: "function_call_output",
            call_id: item.callId,
            output,
          });
          break;
        }
        case "opaque": {
          // opaque items with item_reference purpose can be passed through
          if (
            item.source === "responses" &&
            item.purpose === "replay" &&
            typeof item.payload === "object" &&
            item.payload !== null &&
            "id" in (item.payload as Record<string, unknown>)
          ) {
            const { id } = item.payload as Record<string, unknown>;
            if (typeof id === "string") {
              rollbackTrailingReplayCanonicalItems(input);
              input.push({ type: "item_reference", id });
            }
          }
          break;
        }
      }
    }

    const body: ResponsesAPIRequest = {
      model: request.model,
      input,
      stream: true,
    };

    if (request.instructions) {
      body.instructions = instructionsToResponsesText(request.instructions);
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(
        (t): ResponsesTool => ({
          type: "function",
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        }),
      );
    }

    if (request.toolChoice) {
      if (request.toolChoice === "auto") body.tool_choice = "auto";
      else if (request.toolChoice === "none") body.tool_choice = "none";
      else if (request.toolChoice.type === "tool") {
        body.tool_choice = { type: "function", name: request.toolChoice.name };
      }
    }

    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
    if (request.metadata) body.metadata = request.metadata;

    return body;
  }

  // ── runStream ─────────────────────────────────────────────

  protected async *runStream(
    providerRequest: ResponsesAPIRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    const auxiliary = this.createAuxiliaryState(request);
    const response = await this.fetchFn(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(providerRequest),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`Responses API error ${response.status}: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Response body is not readable");
    }

    // 流式累积状态
    const output: OutputItem[] = [];
    const decoder = new TextDecoder();
    let buffer = "";
    let completedResponse: ResponsesAPIResponse | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { events, rest, malformedEvents } = parseSSE(buffer);
        buffer = rest;

        const malformedWarning = emitMalformedStreamWarning(factory, {
          count: malformedEvents,
          providerLabel: "Responses",
          transportLabel: "SSE event(s)",
        });
        if (malformedWarning) {
          yield malformedWarning;
        }

        for (const sseEvent of events) {
          if (sseEvent.type === "error") {
            yield factory.responseWarning(sseEvent.data.message, sseEvent.data.code);
            continue;
          }

          // item 级事件
          if (sseEvent.type === "response.output_item.added") {
            const item = sseEvent.data.item;
            switch (item.type) {
              case "message":
                yield factory.messageStarted(item.id);
                break;
              case "reasoning":
                yield factory.reasoningStarted(item.id, "full");
                break;
              case "function_call":
                yield factory.toolCallStarted(item.id, ((item as Record<string, unknown>).name as string) ?? "unknown");
                break;
            }
            continue;
          }

          if (sseEvent.type === "response.output_text.delta") {
            yield factory.messageDelta(sseEvent.data.item_id, sseEvent.data.delta);
            continue;
          }

          if (sseEvent.type === "response.output_text.done") {
            yield factory.messageCompleted(messageItem([textBlock(sseEvent.data.text)], { id: sseEvent.data.item_id }));
            output.push(messageItem([textBlock(sseEvent.data.text)], { id: sseEvent.data.item_id }));
            continue;
          }

          if (sseEvent.type === "response.reasoning.delta") {
            yield factory.reasoningDelta(sseEvent.data.item_id, textBlock(sseEvent.data.delta));
            continue;
          }

          if (sseEvent.type === "response.reasoning.done") {
            yield factory.reasoningCompleted(
              reasoningItem([textBlock(sseEvent.data.text)], "full", sseEvent.data.item_id),
            );
            output.push(reasoningItem([textBlock(sseEvent.data.text)], "full", sseEvent.data.item_id));
            continue;
          }

          if (sseEvent.type === "response.tool_call.delta") {
            if (sseEvent.data.delta.arguments) {
              yield factory.toolCallDelta(sseEvent.data.item_id, { argumentsText: sseEvent.data.delta.arguments });
            }
            continue;
          }

          if (sseEvent.type === "response.tool_call.done") {
            const tcItem = toolCallItem(
              sseEvent.data.item_id,
              sseEvent.data.name ?? "unknown",
              sseEvent.data.arguments ?? "",
            );
            yield factory.toolCallCompleted(tcItem);
            output.push(tcItem);
            continue;
          }

          if (sseEvent.type === "response.completed") {
            completedResponse = sseEvent.data.response;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (buffer.trim().length > 0) {
      yield factory.responseWarning("Stream ended with an incomplete Responses SSE frame", "STREAM_ERROR");
    }

    // 解析完成响应中的 usage 和 replay
    let rawResponseId: string | undefined;

    if (completedResponse) {
      rawResponseId = completedResponse.id;
      if (completedResponse.usage) {
        auxiliary.recordUsage(
          {
          inputTokens: completedResponse.usage.input_tokens,
          outputTokens: completedResponse.usage.output_tokens,
          totalTokens: completedResponse.usage.total_tokens,
          },
          "final",
          completedResponse.usage,
        );
      }
    }

    // 构造 replay：在 output 基础上追加 opaque continuation
    const replay = [...replayFromOutput(output)];

    // 如果有 provider continuation id，附加 opaque replay item
    if (completedResponse?.id) {
      replay.push(opaqueItem("responses", "replay", { id: completedResponse.id }));
    }

    // 从 completedResponse 推断 stop reason
    const stopReason = completedResponse ? this.inferStopReason(completedResponse) : undefined;

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
          stopReason,
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

  // ── 辅助方法 ──────────────────────────────────────────────

  private inferStopReason(response: ResponsesAPIResponse): import("../index.js").StopReason {
    const output = response.output;
    if (!output || output.length === 0) return "unknown";

    // 检查是否有未完成的 function_call
    const hasFunctionCall = output.some((item) => item.type === "function_call");
    if (hasFunctionCall) return "tool_call";

    // 检查最后一条 message 的 status
    const lastMsg = output[output.length - 1];
    if (lastMsg?.status === "incomplete") return "max_output_tokens";

    return "end_turn";
  }
}
