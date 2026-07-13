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
import { AIProviderError, AIRequestError, AIStreamError } from "../core/errors.js";
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
import { assertOpaqueReplayEnvelope, providerHttpError } from "../helpers/adapter-security.js";
import { usageFromOpenAIResponses } from "../helpers/usage-mapping.js";
import { NormalizedRequestMapper, splitSSEFrames, IncrementalStreamParser } from "../helpers/index.js";

import type { NormalizedRequest, AIStreamEvent, EventFactory, OutputItem, FetchFn } from "../index.js";

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
  | { type: "message"; role: "user" | "assistant"; content: string }
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

const mapper = new NormalizedRequestMapper("responses");

// ── SSE 事件类型 ──────────────────────────────────────────────

type ResponsesSSEEvent =
  | { type: "response.output_item.added"; data: { item: { id: string; type: string; [key: string]: unknown } } }
  | { type: "response.output_text.delta"; data: { item_id: string; delta: string } }
  | { type: "response.output_text.done"; data: { item_id: string; text: string } }
  | { type: "response.reasoning.delta"; data: { item_id: string; delta: string } }
  | { type: "response.reasoning.done"; data: { item_id: string; text: string } }
  | { type: "response.function_call_arguments.delta"; data: { item_id: string; delta: string } }
  | { type: "response.function_call_arguments.done"; data: { item_id: string; arguments: string } }
  | { type: "response.completed"; data: { response: ResponsesAPIResponse } }
  | { type: "response.failed"; data: { response: ResponsesAPIResponse } }
  | { type: "response.incomplete"; data: { response: ResponsesAPIResponse } }
  | { type: "error"; data: { message: string; code?: string } }
  | { type: string; data: Record<string, unknown> };

/** 已处理或可安全忽略的 Responses SSE 类型（未知类型会 warning 一次）。 */
const KNOWN_RESPONSES_SSE_TYPES = new Set([
  "response.output_item.added",
  "response.output_item.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.reasoning.delta",
  "response.reasoning.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.refusal.delta",
  "response.refusal.done",
  "response.in_progress",
  "response.created",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
]);

type ResponsesAPIResponse = {
  id: string;
  model: string;
  output: ResponsesAPIOutputItem[];
  status?: "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete" | string;
  incomplete_details?: { reason?: string | null } | null;
  error?: { message?: string; code?: string } | null;
  failure?: { message?: string; code?: string } | null;
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

function isReplayCanonicalInput(item: ResponsesInputItem): boolean {
  return (
    (item.type === "message" && item.role === "assistant") || item.type === "reasoning" || item.type === "function_call"
  );
}

function hasReplayCanonicalInput(input: ResponsesInputItem[]): boolean {
  return input.some(isReplayCanonicalInput);
}

function extractFailureMessage(response: ResponsesAPIResponse): string {
  return response.error?.message ?? response.failure?.message ?? "unknown";
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
  readonly isSyntheticStream = false;

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
            const blocks = mapper
              .ensureTextBlocks(item.content, `assistant message (${item.role}) content`)
              .map(canonicalToResponsesBlock);
            input.push({ type: "message", role: item.role, content: blocks });
          } else {
            input.push({
              type: "message",
              role: item.role,
              content: contentBlocksToText(
                mapper.ensureTextBlocks(item.content, `input message (${item.role}) content`),
              ),
            });
          }
          break;
        }
        case "reasoning": {
          const blocks = mapper
            .ensureReasoningBlocks(item.content, "reasoning content")
            .map((b): ResponsesContentBlock => ({ type: "reasoning", text: b.text }));
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
          const output = mapper
            .ensureTextBlocks(item.content, `tool_result ${item.callId} content`)
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
          // Canonical replay items take priority; item_reference is only a fallback
          // when the consumer kept only the provider continuation id.
          if (item.source !== "responses" || item.purpose !== "replay") break;
          assertOpaqueReplayEnvelope(item.payload);
          const payload = item.payload as Record<string, unknown>;
          if ("id" in payload) {
            if (typeof payload.id !== "string" || payload.id.length === 0 || payload.id.length > 256) {
              throw new AIRequestError(
                "Invalid opaque replay payload: id must be a non-empty string (max 256)",
                "INVALID_OPAQUE_REPLAY",
              );
            }
            if (!hasReplayCanonicalInput(input)) {
              input.push({ type: "item_reference", id: payload.id });
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
      body.instructions = mapper.mapInstructions(request.instructions);
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
    let response: Response;

    try {
      response = await this.fetchFn(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(providerRequest),
        signal: request.signal,
      });
    } catch (err) {
      throw new AIProviderError(err instanceof Error ? err.message : String(err), "PROVIDER_ERROR");
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw providerHttpError(response.status, errorBody);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new AIStreamError("Response body is not readable", "STREAM_ERROR");
    }

    // 流式累积状态
    const parser = new IncrementalStreamParser<ResponsesSSEEvent>(splitSSEFrames, (frame: string) => {
      let eventType = "";
      let dataStr = "";
      for (const rawLine of frame.split("\n")) {
        const line = rawLine.trim();
        if (line.startsWith("event: ")) eventType = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataStr += line.slice(6);
      }
      if (!eventType) return { status: "ignored" };
      try {
        const data = JSON.parse(dataStr);
        return { status: "parsed", value: { type: eventType, data } as ResponsesSSEEvent };
      } catch {
        return { status: "malformed" };
      }
    });

    const output: OutputItem[] = [];
    let streamDone = false;
    let completedResponse: ResponsesAPIResponse | undefined;
    let completedEmitted = false;
    let unknownEventsWarned = false;
    const messageItemsWithDelta = new Set<string>();
    const toolCallNames = new Map<string, string>();

    try {
      while (true) {
        const readResult = await reader.read().catch((err: unknown) => {
          throw new AIStreamError(
            `Failed to read response stream: ${err instanceof Error ? err.message : String(err)}`,
            "STREAM_ERROR",
          );
        });
        const { done, value } = readResult;
        const { items: events, malformed: malformedEvents } = done ? parser.flush() : parser.feed(value as Uint8Array);

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
            const data = sseEvent.data as { message?: string; code?: string };
            yield factory.responseWarning(data.message ?? "Provider error event", data.code);
            continue;
          }

          // item 级事件
          if (sseEvent.type === "response.output_item.added") {
            const item = (sseEvent.data as { item: { id: string; type: string; [key: string]: unknown } }).item;
            switch (item.type) {
              case "message":
                yield factory.messageStarted(item.id);
                break;
              case "reasoning":
                yield factory.reasoningStarted(item.id, "full");
                break;
              case "function_call": {
                const name = typeof item.name === "string" ? item.name : "unknown";
                toolCallNames.set(item.id, name);
                yield factory.toolCallStarted(item.id, name);
                break;
              }
            }
            continue;
          }

          if (sseEvent.type === "response.output_text.delta") {
            const data = sseEvent.data as { item_id: string; delta: string };
            yield factory.messageDelta(data.item_id, textBlock(data.delta));
            messageItemsWithDelta.add(data.item_id);
            continue;
          }

          if (sseEvent.type === "response.output_text.done") {
            const data = sseEvent.data as { item_id: string; text: string };
            if (!messageItemsWithDelta.has(data.item_id) && data.text) {
              yield factory.messageDelta(data.item_id, textBlock(data.text));
            }
            yield factory.messageCompleted(data.item_id);
            output.push(messageItem([textBlock(data.text)], { id: data.item_id }));
            continue;
          }

          if (sseEvent.type === "response.reasoning.delta") {
            const data = sseEvent.data as { item_id: string; delta: string };
            yield factory.reasoningDelta(data.item_id, textBlock(data.delta));
            continue;
          }

          if (sseEvent.type === "response.reasoning.done") {
            const data = sseEvent.data as { item_id: string; text: string };
            yield factory.reasoningCompleted(data.item_id);
            output.push(reasoningItem([textBlock(data.text)], "full", data.item_id));
            continue;
          }

          if (sseEvent.type === "response.function_call_arguments.delta") {
            const data = sseEvent.data as { item_id: string; delta: string };
            if (data.delta) yield factory.toolCallDelta(data.item_id, { argumentsText: data.delta });
            continue;
          }

          if (sseEvent.type === "response.function_call_arguments.done") {
            const data = sseEvent.data as { item_id: string; arguments: string };
            const tcItem = toolCallItem(data.item_id, toolCallNames.get(data.item_id) ?? "unknown", data.arguments);
            yield factory.toolCallCompleted(data.item_id);
            output.push(tcItem);
            continue;
          }

          if (
            sseEvent.type === "response.completed" ||
            sseEvent.type === "response.failed" ||
            sseEvent.type === "response.incomplete"
          ) {
            const data = sseEvent.data as { response: ResponsesAPIResponse };
            if (completedResponse) {
              yield factory.responseWarning("Duplicate finish signal ignored", "DUPLICATE_FINISH");
              continue;
            }

            completedResponse = data.response;

            if (sseEvent.type === "response.failed") {
              yield factory.responseWarning(
                `Response failed: ${extractFailureMessage(data.response)}`,
                "PROVIDER_FAILURE",
              );
            }
            continue;
          }

          if (!KNOWN_RESPONSES_SSE_TYPES.has(sseEvent.type) && !unknownEventsWarned) {
            unknownEventsWarned = true;
            yield factory.responseWarning(
              `Responses API sent unknown event type "${sseEvent.type}"; this may indicate an incomplete integration`,
              "UNKNOWN_PROVIDER_EVENT",
            );
          }
        }

        if (done) {
          streamDone = true;
          break;
        }
      }
    } finally {
      try {
        if (!streamDone) await reader.cancel().catch(() => undefined);
      } finally {
        reader.releaseLock();
      }
    }

    if (parser.getRemaining().trim().length > 0) {
      yield factory.responseWarning("Stream ended with an incomplete Responses SSE frame", "STREAM_ERROR");
    }

    // 解析完成响应中的 usage 和 replay
    let rawResponseId: string | undefined;

    if (completedResponse) {
      rawResponseId = completedResponse.id;
      if (completedResponse.usage) {
        auxiliary.recordUsage(usageFromOpenAIResponses(completedResponse.usage), "final", completedResponse.usage);
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

    if (!completedEmitted) {
      completedEmitted = true;
      const finalResponse = this.buildResponse(
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
      );
      yield factory.responseCompleted({
        replay: finalResponse.replay,
        stopReason: finalResponse.stopReason,
        trace: finalResponse.backend,
        usage: finalResponse.usage,
        billing: finalResponse.billing,
        auxiliary: finalResponse.auxiliary,
        warnings: finalResponse.warnings,
      });
    }
  }

  // ── 辅助方法 ──────────────────────────────────────────────

  private inferStopReason(response: ResponsesAPIResponse): import("../index.js").StopReason {
    if (response.status === "failed") return "error";

    if (response.status === "incomplete") {
      const reason = response.incomplete_details?.reason;
      if (reason === "content_filter") return "content_filter";
      if (reason === "max_output_tokens") return "max_output_tokens";
      return "max_output_tokens";
    }

    const output = response.output;
    if (!output || output.length === 0) {
      return response.status === "completed" ? "end_turn" : "unknown";
    }

    const hasFunctionCall = output.some((item) => item.type === "function_call");
    if (hasFunctionCall) return "tool_call";

    const lastItem = output[output.length - 1];
    if (lastItem?.status === "failed") return "error";
    if (lastItem?.status === "incomplete") return "max_output_tokens";

    return "end_turn";
  }
}
