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

import { AdapterBase } from "../../provider/base.js";
import { AIRequestError } from "../../runtime/errors.js";
import {
  textBlock,
  jsonBlock,
  imageBlock,
  messageItem,
  reasoningItem,
  toolCallItem,
  opaqueItem,
  serverToolCallItem,
  serverToolResultItem,
  serverToolDiscoveryItem,
  replayFromOutput,
} from "../../canonical/index.js";
import { assertOpaqueReplayEnvelope } from "../../provider/security.js";
import { usageFromOpenAIResponses } from "../../provider/usage/index.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";
import { createSseJsonParser } from "../../provider/transport/parser.js";
import {
  openProviderJsonStream,
  iterateProviderStreamBatches,
  createCompletionGate,
} from "../../provider/transport/open-stream.js";
import { mergeProviderHeaders, applyExtraBody } from "../../provider/request-options.js";
import { mapResponsesReasoning } from "../../provider/reasoning.js";

import type {
  NormalizedRequest,
  AIStreamEvent,
  Citation,
  ContentBlock,
  FetchFn,
  OutputItem,
  ReasoningItem,
  ServerToolCallItem,
  ServerToolDefinition,
  ServerToolDiscoveryItem,
  ServerToolResultItem,
  StopReason,
} from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";

// ── 类型 ──────────────────────────────────────────────────────

import type {
  ResponsesAdapterOptions,
  ResponsesAPIRequest,
  ResponsesEasyMessage,
  ResponsesInputContentPart,
  ResponsesFunctionCall,
  ResponsesFunctionCallOutput,
  ResponsesReasoningInput,
  ResponsesItemReference,
  ResponsesInputItem,
  ResponsesTool,
  ResponsesWebSearchTool,
  ResponsesCodeInterpreterTool,
  ResponsesMcpTool,
} from "./types.js";

const mapper = new NormalizedRequestMapper("responses");

/** 将 canonical serverTools 映射为 Responses API tools 数组项。 */
function mapServerTools(serverTools: ServerToolDefinition[] | undefined): ResponsesTool[] {
  if (!serverTools || serverTools.length === 0) return [];

  return serverTools.map((tool): ResponsesTool => {
    switch (tool.type) {
      case "web_search": {
        const mapped: ResponsesWebSearchTool = { type: "web_search" };
        if (tool.allowedDomains || tool.blockedDomains) {
          mapped.filters = {
            ...(tool.allowedDomains ? { allowed_domains: tool.allowedDomains } : {}),
            ...(tool.blockedDomains ? { blocked_domains: tool.blockedDomains } : {}),
          };
        }
        if (tool.userLocation) {
          mapped.user_location = {
            type: "approximate",
            ...(tool.userLocation.country !== undefined ? { country: tool.userLocation.country } : {}),
            ...(tool.userLocation.city !== undefined ? { city: tool.userLocation.city } : {}),
            ...(tool.userLocation.region !== undefined ? { region: tool.userLocation.region } : {}),
            ...(tool.userLocation.timezone !== undefined ? { timezone: tool.userLocation.timezone } : {}),
          };
        }
        if (tool.searchContextSize !== undefined) {
          mapped.search_context_size = tool.searchContextSize;
        }
        return mapped;
      }
      case "code_execution": {
        const container = tool.container;
        const mapped: ResponsesCodeInterpreterTool = {
          type: "code_interpreter",
          container: container
            ? {
                type: "auto",
                ...(container.memoryLimit !== undefined ? { memory_limit: container.memoryLimit } : {}),
                ...(container.fileIds !== undefined ? { file_ids: container.fileIds } : {}),
              }
            : { type: "auto" },
        };
        return mapped;
      }
      case "mcp": {
        const mapped: ResponsesMcpTool = {
          type: "mcp",
          server_label: tool.serverLabel,
          server_url: tool.serverUrl,
          require_approval: "never",
        };
        if (tool.serverDescription !== undefined) mapped.server_description = tool.serverDescription;
        if (tool.authorization !== undefined) mapped.authorization = tool.authorization;
        if (tool.allowedTools !== undefined) mapped.allowed_tools = tool.allowedTools;
        return mapped;
      }
      default: {
        const exhaustive: never = tool;
        throw new AIRequestError(
          `Unsupported server tool type: ${(exhaustive as ServerToolDefinition).type}`,
          "UNSUPPORTED_SERVER_TOOL",
        );
      }
    }
  });
}

// ── SSE 事件类型 ──────────────────────────────────────────────

type ResponsesSSEEvent =
  | { type: "response.output_item.added"; data: { item: { id: string; type: string; [key: string]: unknown } } }
  | { type: "response.output_item.done"; data: { item: { id: string; type: string; [key: string]: unknown } } }
  | { type: "response.output_text.delta"; data: { item_id: string; delta: string } }
  | { type: "response.output_text.done"; data: { item_id: string; text: string } }
  | { type: "response.reasoning.delta"; data: { item_id: string; delta: string } }
  | { type: "response.reasoning.done"; data: { item_id: string; text: string } }
  | { type: "response.reasoning_summary_part.added"; data: { item_id: string; summary_index: number; part?: unknown } }
  | { type: "response.reasoning_summary_part.done"; data: { item_id: string; summary_index: number; part?: unknown } }
  | { type: "response.reasoning_summary_text.delta"; data: { item_id: string; delta: string; summary_index?: number } }
  | { type: "response.reasoning_summary_text.done"; data: { item_id: string; text: string; summary_index?: number } }
  | { type: "response.reasoning_text.delta"; data: { item_id: string; delta: string; content_index?: number } }
  | { type: "response.reasoning_text.done"; data: { item_id: string; text: string; content_index?: number } }
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
  "response.output_text.annotation.added",
  // legacy aliases retained for fixtures / older gateways
  "response.reasoning.delta",
  "response.reasoning.done",
  // current OpenAI reasoning summary + full reasoning text events
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  // server tools
  "response.web_search_call.in_progress",
  "response.web_search_call.searching",
  "response.web_search_call.completed",
  "response.code_interpreter_call.in_progress",
  "response.code_interpreter_call.interpreting",
  "response.code_interpreter_call.completed",
  "response.code_interpreter_call_code.delta",
  "response.code_interpreter_call_code.done",
  "response.mcp_call.in_progress",
  "response.mcp_call.completed",
  "response.mcp_call.failed",
  "response.mcp_call_arguments.delta",
  "response.mcp_call_arguments.done",
  "response.mcp_list_tools.in_progress",
  "response.mcp_list_tools.completed",
  "response.mcp_list_tools.failed",
  "response.content_part.added",
  "response.content_part.done",
  "response.refusal.delta",
  "response.refusal.done",
  "response.in_progress",
  "response.created",
  "response.queued",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
]);

function mapAnnotationToCitation(annotation: Record<string, unknown>): Citation | undefined {
  if (annotation.type === "url_citation" && typeof annotation.url === "string") {
    return {
      type: "url",
      url: annotation.url,
      ...(typeof annotation.title === "string" ? { title: annotation.title } : {}),
      ...(typeof annotation.start_index === "number" ? { startIndex: annotation.start_index } : {}),
      ...(typeof annotation.end_index === "number" ? { endIndex: annotation.end_index } : {}),
    };
  }

  if (
    annotation.type === "container_file_citation" &&
    typeof annotation.container_id === "string" &&
    typeof annotation.file_id === "string"
  ) {
    return {
      type: "container_file",
      containerId: annotation.container_id,
      fileId: annotation.file_id,
      ...(typeof annotation.filename === "string" ? { filename: annotation.filename } : {}),
      ...(typeof annotation.start_index === "number" ? { startIndex: annotation.start_index } : {}),
      ...(typeof annotation.end_index === "number" ? { endIndex: annotation.end_index } : {}),
    };
  }

  return undefined;
}

function extractCitationsFromMessageItem(item: Record<string, unknown>): Citation[] {
  const citations: Citation[] = [];
  if (!Array.isArray(item.content)) return citations;
  for (const part of item.content) {
    if (!part || typeof part !== "object") continue;
    const annotations = (part as { annotations?: unknown }).annotations;
    if (!Array.isArray(annotations)) continue;
    for (const annotation of annotations) {
      if (!annotation || typeof annotation !== "object") continue;
      const mapped = mapAnnotationToCitation(annotation as Record<string, unknown>);
      if (mapped) citations.push(mapped);
    }
  }
  return citations;
}

function webSearchArgumentsText(action: unknown): string | undefined {
  if (!action || typeof action !== "object") return undefined;
  const record = action as Record<string, unknown>;
  if (typeof record.query === "string" && record.query.length > 0) {
    return JSON.stringify({ query: record.query });
  }
  if (Array.isArray(record.queries) && record.queries.every((q) => typeof q === "string")) {
    return JSON.stringify({ queries: record.queries });
  }
  if (record.type === "open_page" && typeof record.url === "string") {
    return JSON.stringify({ url: record.url });
  }
  if (record.type === "find_in_page") {
    return JSON.stringify({
      ...(typeof record.pattern === "string" ? { pattern: record.pattern } : {}),
      ...(typeof record.url === "string" ? { url: record.url } : {}),
    });
  }
  return undefined;
}

function mapWebSearchCallItem(item: Record<string, unknown>): {
  call: ServerToolCallItem;
  result?: ServerToolResultItem;
} {
  const action = item.action;
  const status =
    item.status === "failed" ? "failed" : item.status === "completed" ? "completed" : "in_progress";
  const name =
    action && typeof action === "object" && typeof (action as { type?: unknown }).type === "string"
      ? ((action as { type: string }).type)
      : undefined;
  const call = serverToolCallItem(item.id as string, "web_search", {
    name,
    argumentsText: webSearchArgumentsText(action),
    status,
    providerPayload: {
      ...(action !== undefined ? { action } : {}),
      ...(item.status !== undefined ? { status: item.status } : {}),
    },
  });

  const sources =
    action &&
    typeof action === "object" &&
    Array.isArray((action as { sources?: unknown }).sources)
      ? (action as { sources: unknown[] }).sources
      : undefined;
  if (!sources || sources.length === 0) {
    return { call };
  }

  return {
    call,
    result: serverToolResultItem(
      call.id,
      "web_search",
      status === "failed" ? "error" : "success",
      [jsonBlock({ sources })],
      { providerPayload: { sources } },
    ),
  };
}

function mapCodeInterpreterOutputs(outputs: unknown): ContentBlock[] {
  if (!Array.isArray(outputs)) return [];
  const blocks: ContentBlock[] = [];
  for (const output of outputs) {
    if (!output || typeof output !== "object") continue;
    const record = output as Record<string, unknown>;
    if (record.type === "logs" && typeof record.logs === "string") {
      blocks.push(textBlock(record.logs));
    } else if (record.type === "image" && typeof record.url === "string") {
      blocks.push(imageBlock(record.url));
    } else {
      blocks.push(jsonBlock(record));
    }
  }
  return blocks;
}

function mapCodeInterpreterCallItem(item: Record<string, unknown>): {
  call: ServerToolCallItem;
  result?: ServerToolResultItem;
} {
  const status =
    item.status === "failed" ? "failed" : item.status === "completed" ? "completed" : "in_progress";
  const code = typeof item.code === "string" ? item.code : undefined;
  const call = serverToolCallItem(item.id as string, "code_execution", {
    name: "python",
    argumentsText: code,
    status,
    providerPayload: {
      ...(typeof item.container_id === "string" ? { containerId: item.container_id } : {}),
      ...(item.status !== undefined ? { status: item.status } : {}),
    },
  });

  const content = mapCodeInterpreterOutputs(item.outputs);
  if (content.length === 0 && status !== "failed") {
    return { call };
  }

  return {
    call,
    result: serverToolResultItem(call.id, "code_execution", status === "failed" ? "error" : "success", content, {
      providerPayload: {
        ...(typeof item.container_id === "string" ? { containerId: item.container_id } : {}),
        ...(item.outputs !== undefined ? { outputs: item.outputs } : {}),
      },
    }),
  };
}

function mapMcpCallItem(item: Record<string, unknown>): {
  call: ServerToolCallItem;
  result: ServerToolResultItem;
} {
  const failed = item.error != null && item.error !== "";
  const call = serverToolCallItem(item.id as string, "mcp", {
    name: typeof item.name === "string" ? item.name : undefined,
    argumentsText: typeof item.arguments === "string" ? item.arguments : undefined,
    serverLabel: typeof item.server_label === "string" ? item.server_label : undefined,
    status: failed ? "failed" : "completed",
    providerPayload: {
      ...(item.approval_request_id !== undefined ? { approvalRequestId: item.approval_request_id } : {}),
      ...(item.error !== undefined ? { error: item.error } : {}),
    },
  });

  const content: ContentBlock[] = [];
  if (typeof item.output === "string" && item.output.length > 0) {
    content.push(textBlock(item.output));
  } else if (item.output !== undefined && item.output !== null) {
    content.push(jsonBlock(item.output));
  }
  if (failed) {
    content.push(
      textBlock(
        typeof item.error === "string"
          ? item.error
          : JSON.stringify(item.error ?? "mcp call failed"),
      ),
    );
  }

  return {
    call,
    result: serverToolResultItem(call.id, "mcp", failed ? "error" : "success", content, {
      providerPayload: {
        ...(typeof item.server_label === "string" ? { serverLabel: item.server_label } : {}),
        ...(item.error !== undefined ? { error: item.error } : {}),
      },
    }),
  };
}

function mapMcpListToolsItem(item: Record<string, unknown>): ServerToolDiscoveryItem {
  const tools: ServerToolDiscoveryItem["tools"] = [];
  if (Array.isArray(item.tools)) {
    for (const tool of item.tools) {
      if (!tool || typeof tool !== "object") continue;
      const record = tool as Record<string, unknown>;
      if (typeof record.name !== "string") continue;
      tools.push({
        name: record.name,
        ...(typeof record.description === "string" ? { description: record.description } : {}),
        ...(record.input_schema !== undefined ? { inputSchema: record.input_schema } : {}),
      });
    }
  }

  return serverToolDiscoveryItem(
    item.id as string,
    typeof item.server_label === "string" ? item.server_label : "unknown",
    tools,
    {
      providerPayload: {
        ...(item.error !== undefined ? { error: item.error } : {}),
        ...(item.tools !== undefined ? { tools: item.tools } : {}),
      },
    },
  );
}

type ReasoningVisibility = ReasoningItem["visibility"];

type ReasoningStreamState = {
  visibility: ReasoningVisibility;
  hasDelta: boolean;
  /** Accumulated final texts from *.done events when deltas were skipped. */
  doneTexts: string[];
  completed: boolean;
};

function createReasoningState(visibility: ReasoningVisibility = "summary"): ReasoningStreamState {
  return { visibility, hasDelta: false, doneTexts: [], completed: false };
}

function extractReasoningFromOutputItem(item: Record<string, unknown>): {
  text: string;
  visibility: ReasoningVisibility;
} {
  const contentTexts: string[] = [];
  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "reasoning_text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        contentTexts.push((part as { text: string }).text);
      }
    }
  }

  const summaryTexts: string[] = [];
  if (Array.isArray(item.summary)) {
    for (const part of item.summary) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "summary_text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        summaryTexts.push((part as { text: string }).text);
      }
    }
  }

  if (contentTexts.length > 0) {
    return { text: contentTexts.join("\n"), visibility: "full" };
  }
  if (summaryTexts.length > 0) {
    return { text: summaryTexts.join("\n"), visibility: "summary" };
  }
  if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
    return { text: "", visibility: "opaque" };
  }
  return { text: "", visibility: "summary" };
}

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
  type: "message" | "reasoning" | "function_call" | string;
  role?: string;
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  summary?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  encrypted_content?: string | null;
  name?: string;
  arguments?: string;
  call_id?: string;
  status?: string;
  [key: string]: unknown;
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

function readNonEmptyString(value: unknown, maxLen = 256): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLen) return undefined;
  return value;
}

/** 将 canonical text/json blocks 压成 EasyInputMessage 的 string content。 */
function messageContentAsString(
  blocks: ContentBlock[],
  field: string,
): string {
  return mapper.textFromBlocks(blocks, field);
}

function mapReasoningInput(item: ReasoningItem, index: number): ResponsesReasoningInput {
  const text = mapper.textFromBlocks(
    mapper.ensureReasoningBlocks(item.content, "reasoning content"),
    "reasoning content",
  );
  const id = item.id && item.id.length > 0 ? item.id : `reasoning_replay_${index}`;

  if (item.visibility === "full") {
    return {
      type: "reasoning",
      id,
      summary: [],
      content: text ? [{ type: "reasoning_text", text }] : undefined,
    };
  }

  // summary / redacted / opaque：公开可回传的是 summary_text
  return {
    type: "reasoning",
    id,
    summary: text ? [{ type: "summary_text", text }] : [],
  };
}

function extractOpaqueContinuationId(payload: Record<string, unknown>): {
  previousResponseId?: string;
  itemReferenceId?: string;
} {
  // 优先显式 previous_response_id；历史 payload 用 id 存 response 续写句柄
  const previousResponseId =
    readNonEmptyString(payload.previous_response_id) ??
    (typeof payload.item_id === "string" ? undefined : readNonEmptyString(payload.id));

  // 仅在显式给出 item_id 时使用 item_reference（引用的是 item，不是 response）
  const itemReferenceId = readNonEmptyString(payload.item_id);

  return { previousResponseId, itemReferenceId };
}

// ── Adapter ───────────────────────────────────────────────────

export class ResponsesAdapter extends AdapterBase {
  readonly kind = "responses" as const;
  readonly isSyntheticStream = false;

  private apiKey: string;
  private baseUrl: string;
  private fetchFn: FetchFn;
  private headers: Record<string, string> | undefined;
  private extraBody: Record<string, unknown> | undefined;

  constructor(options: ResponsesAdapterOptions) {
    super();
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.headers = options.headers;
    this.extraBody = options.extraBody;
  }

  // ── buildRequest ──────────────────────────────────────────

  protected buildRequest(request: NormalizedRequest): ResponsesAPIRequest {
    const input: ResponsesInputItem[] = [];
    let previousResponseId: string | undefined;
    let reasoningIndex = 0;

    for (const item of request.input) {
      switch (item.type) {
        case "message": {
          // EasyInputMessage：string content 对 user/assistant 都合法，且最不易触发 ModelInput 反序列化失败。
          // 切勿发送 { type: "text" } —— 官方 content part 是 input_text / output_text。
          input.push({
            type: "message",
            role: item.role,
            content: messageContentAsString(item.content, `input message (${item.role}) content`),
          });
          break;
        }
        case "reasoning": {
          input.push(mapReasoningInput(item, reasoningIndex++));
          break;
        }
        case "tool_call": {
          // call_id 必填；canonical ToolCallItem.id 即 call_id（流里会优先取 call_id）
          input.push({
            type: "function_call",
            call_id: item.id,
            name: item.name,
            arguments: item.argumentsText,
          });
          break;
        }
        case "tool_result": {
          const output = mapper.textFromBlocks(item.content, `tool_result ${item.callId} content`);
          input.push({
            type: "function_call_output",
            call_id: item.callId,
            output,
          });
          break;
        }
        case "opaque": {
          // Canonical replay 优先；否则用 previous_response_id 做服务端续写。
          // 注意：response id 不能塞进 item_reference（那是 item id）。
          if (item.source !== "responses" || item.purpose !== "replay") break;
          assertOpaqueReplayEnvelope(item.payload);
          const payload = item.payload as Record<string, unknown>;

          // 显式字段校验：id / previous_response_id / item_id 若存在必须是合法 string
          for (const key of ["id", "previous_response_id", "item_id"] as const) {
            if (key in payload && (typeof payload[key] !== "string" || payload[key].length === 0 || payload[key].length > 256)) {
              throw new AIRequestError(
                `Invalid opaque replay payload: ${key} must be a non-empty string (max 256)`,
                "INVALID_OPAQUE_REPLAY",
              );
            }
          }

          const { previousResponseId: prevId, itemReferenceId } = extractOpaqueContinuationId(payload);
          if (!hasReplayCanonicalInput(input)) {
            if (prevId && !previousResponseId) {
              previousResponseId = prevId;
            } else if (itemReferenceId) {
              input.push({ type: "item_reference", id: itemReferenceId });
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

    if (previousResponseId) {
      body.previous_response_id = previousResponseId;
    }

    if (request.instructions) {
      body.instructions = mapper.mapInstructions(request.instructions);
    }

    const functionTools =
      mapper.mapToolsIfPresent(
        request.tools,
        (t): ResponsesTool => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        }),
      ) ?? [];
    const serverTools = mapServerTools(request.serverTools);
    const tools = [...functionTools, ...serverTools];
    if (tools.length > 0) {
      body.tools = tools;
    }

    body.tool_choice = mapper.mapToolChoice<Exclude<ResponsesAPIRequest["tool_choice"], undefined>>(
      request.toolChoice,
      {
        auto: "auto",
        none: "none",
        tool: (name) => ({ type: "function" as const, name }),
      },
    );

    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
    if (request.metadata) body.metadata = request.metadata;
    if (request.reasoningLevel !== undefined) {
      body.reasoning = mapResponsesReasoning(request.reasoningLevel);
    }

    return applyExtraBody(body, this.extraBody);
  }

  // ── runStream ─────────────────────────────────────────────

  protected async *runStream(
    providerRequest: ResponsesAPIRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    const auxiliary = this.createAuxiliaryState(request);
    const gate = createCompletionGate();

    const { reader } = await openProviderJsonStream({
      fetchFn: this.fetchFn,
      url: `${this.baseUrl}/responses`,
      headers: mergeProviderHeaders(
        {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        this.headers,
      ),
      body: providerRequest,
      signal: request.signal,
    });

    const parser = createSseJsonParser<ResponsesSSEEvent>();
    const output: OutputItem[] = [];
    let completedResponse: ResponsesAPIResponse | undefined;
    let unknownEventsWarned = false;
    const messageItemsWithDelta = new Set<string>();
    /** item_id → function name */
    const toolCallNames = new Map<string, string>();
    /** item_id → call_id（canonical ToolCallItem.id / function_call_output.call_id） */
    const toolCallIds = new Map<string, string>();
    const reasoningStates = new Map<string, ReasoningStreamState>();
    /** message item_id → citations accumulated from annotation events / item.done */
    const messageCitations = new Map<string, Citation[]>();
    /** already completed message ids (avoid double message.completed) */
    const completedMessageIds = new Set<string>();
    /** server tool call ids already completed */
    const completedServerToolIds = new Set<string>();
    /** server tool ids that already streamed argument deltas */
    const serverToolArgDeltas = new Set<string>();

    const resolveToolCallId = (itemId: string): string => toolCallIds.get(itemId) ?? itemId;

    const pushCitation = (itemId: string, citation: Citation): void => {
      const list = messageCitations.get(itemId) ?? [];
      list.push(citation);
      messageCitations.set(itemId, list);
    };

    const emitServerToolTerminal = function* (
      call: ServerToolCallItem,
      result?: ServerToolResultItem,
    ): Generator<AIStreamEvent, void, undefined> {
      if (completedServerToolIds.has(call.id)) return;
      completedServerToolIds.add(call.id);
      // 若未流式吐过 arguments，用 done 载荷补齐（避免与 delta 重复拼接）
      if (call.argumentsText && !serverToolArgDeltas.has(call.id)) {
        yield factory.serverToolDelta(call.id, { argumentsText: call.argumentsText });
        serverToolArgDeltas.add(call.id);
      }
      yield factory.serverToolCompleted(call.id, {
        status: call.status === "failed" ? "failed" : "completed",
        providerPayload: call.providerPayload,
      });
      output.push(call);
      if (result) {
        yield factory.serverToolResultCompleted(result);
        output.push(result);
      }
    };

    const ensureReasoningState = (itemId: string, visibility: ReasoningVisibility = "summary"): ReasoningStreamState => {
      let state = reasoningStates.get(itemId);
      if (!state) {
        state = createReasoningState(visibility);
        reasoningStates.set(itemId, state);
      }
      return state;
    };

    const completeReasoning = function* (
      itemId: string,
      text: string,
      visibility: ReasoningVisibility,
    ): Generator<AIStreamEvent, void, undefined> {
      const state = ensureReasoningState(itemId, visibility);
      if (state.completed) return;
      state.completed = true;
      state.visibility = visibility;
      yield factory.reasoningCompleted(itemId);
      output.push(reasoningItem(text ? [textBlock(text)] : [], visibility, itemId));
    };

    for await (const batch of iterateProviderStreamBatches({
      reader,
      parser,
      factory,
      providerLabel: "Responses",
      transportLabel: "SSE event(s)",
      incompleteMessage: "Stream ended with an incomplete Responses SSE frame",
    })) {
      for (const warning of batch.warnings) yield warning;

      for (const sseEvent of batch.items) {
        if (sseEvent.type === "error") {
          const data = sseEvent.data as { message?: string; code?: string };
          yield factory.responseWarning(data.message ?? "Provider error event", data.code);
          continue;
        }

        if (sseEvent.type === "response.output_item.added") {
          const item = (sseEvent.data as { item: { id: string; type: string; [key: string]: unknown } }).item;
          switch (item.type) {
            case "message":
              yield factory.messageStarted(item.id);
              break;
            case "reasoning": {
              // OpenAI 公开流默认是 summary；full/opaque 在后续事件中再收紧。
              const visibility = extractReasoningFromOutputItem(item).visibility;
              ensureReasoningState(item.id, visibility);
              yield factory.reasoningStarted(item.id, visibility);
              break;
            }
            case "function_call": {
              const name = typeof item.name === "string" ? item.name : "unknown";
              // Responses 用 call_id 关联 function_call_output；item.id 是 fc_* item id
              const callId =
                typeof item.call_id === "string" && item.call_id.length > 0 ? item.call_id : item.id;
              toolCallNames.set(item.id, name);
              toolCallIds.set(item.id, callId);
              yield factory.toolCallStarted(callId, name);
              break;
            }
            case "web_search_call": {
              const action = item.action;
              const name =
                action && typeof action === "object" && typeof (action as { type?: unknown }).type === "string"
                  ? (action as { type: string }).type
                  : undefined;
              yield factory.serverToolStarted(item.id, "web_search", { name });
              break;
            }
            case "code_interpreter_call": {
              yield factory.serverToolStarted(item.id, "code_execution", { name: "python" });
              break;
            }
            case "mcp_call": {
              yield factory.serverToolStarted(item.id, "mcp", {
                name: typeof item.name === "string" ? item.name : undefined,
                serverLabel: typeof item.server_label === "string" ? item.server_label : undefined,
              });
              break;
            }
            case "mcp_list_tools":
              // discovery 在 done 时原子发射
              break;
            case "mcp_approval_request":
              yield factory.responseWarning(
                `MCP approval requested for tool "${typeof item.name === "string" ? item.name : "unknown"}" on server "${typeof item.server_label === "string" ? item.server_label : "unknown"}"; requireApproval never expected`,
                "MCP_APPROVAL_REQUIRED",
              );
              break;
          }
          continue;
        }

        if (sseEvent.type === "response.output_item.done") {
          const item = (sseEvent.data as { item: { id: string; type: string; [key: string]: unknown } }).item;
          if (item.type === "reasoning") {
            const extracted = extractReasoningFromOutputItem(item);
            const state = ensureReasoningState(item.id, extracted.visibility);
            const text =
              extracted.text ||
              (state.doneTexts.length > 0 ? state.doneTexts.join("\n") : "");
            yield* completeReasoning(item.id, text, extracted.visibility || state.visibility);
            continue;
          }

          if (item.type === "message") {
            for (const citation of extractCitationsFromMessageItem(item)) {
              pushCitation(item.id, citation);
            }
            // 若 text.done 已完成消息，补写 citations 到本地 output（aggregator 已关闭该 item）
            const citations = messageCitations.get(item.id);
            if (citations && citations.length > 0) {
              for (const out of output) {
                if (out.type === "message" && out.id === item.id) {
                  out.citations = citations;
                }
              }
            }
            continue;
          }

          if (item.type === "web_search_call") {
            const mapped = mapWebSearchCallItem(item);
            yield* emitServerToolTerminal(mapped.call, mapped.result);
            continue;
          }

          if (item.type === "code_interpreter_call") {
            const mapped = mapCodeInterpreterCallItem(item);
            yield* emitServerToolTerminal(mapped.call, mapped.result);
            continue;
          }

          if (item.type === "mcp_call") {
            const mapped = mapMcpCallItem(item);
            yield* emitServerToolTerminal(mapped.call, mapped.result);
            continue;
          }

          if (item.type === "mcp_list_tools") {
            const discovery = mapMcpListToolsItem(item);
            yield factory.serverToolDiscoveryCompleted(discovery);
            output.push(discovery);
            continue;
          }

          if (item.type === "mcp_approval_request") {
            yield factory.responseWarning(
              `MCP approval request item "${item.id}" completed; approval flow is not supported in MVP`,
              "MCP_APPROVAL_REQUIRED",
            );
            continue;
          }

          continue;
        }

        if (sseEvent.type === "response.output_text.delta") {
          const data = sseEvent.data as { item_id: string; delta: string };
          yield factory.messageDelta(data.item_id, textBlock(data.delta));
          messageItemsWithDelta.add(data.item_id);
          continue;
        }

        if (sseEvent.type === "response.output_text.annotation.added") {
          const data = sseEvent.data as {
            item_id?: string;
            annotation?: Record<string, unknown>;
          };
          if (typeof data.item_id === "string" && data.annotation) {
            const citation = mapAnnotationToCitation(data.annotation);
            if (citation) pushCitation(data.item_id, citation);
          }
          continue;
        }

        if (sseEvent.type === "response.output_text.done") {
          const data = sseEvent.data as { item_id: string; text: string };
          if (!messageItemsWithDelta.has(data.item_id) && data.text) {
            yield factory.messageDelta(data.item_id, textBlock(data.text));
          }
          if (!completedMessageIds.has(data.item_id)) {
            completedMessageIds.add(data.item_id);
            const citations = messageCitations.get(data.item_id);
            // 复制数组，避免后续 output_item.done 再 push 时污染已完成 message
            const citationsSnapshot = citations && citations.length > 0 ? [...citations] : undefined;
            yield factory.messageCompleted(
              data.item_id,
              citationsSnapshot ? { citations: citationsSnapshot } : undefined,
            );
            output.push(
              messageItem([textBlock(data.text)], {
                id: data.item_id,
                ...(citationsSnapshot ? { citations: citationsSnapshot } : {}),
              }),
            );
          }
          continue;
        }

        if (
          sseEvent.type === "response.code_interpreter_call_code.delta" ||
          sseEvent.type === "response.mcp_call_arguments.delta"
        ) {
          const data = sseEvent.data as { item_id: string; delta?: string };
          if (typeof data.item_id === "string" && typeof data.delta === "string" && data.delta.length > 0) {
            serverToolArgDeltas.add(data.item_id);
            yield factory.serverToolDelta(data.item_id, { argumentsText: data.delta });
          }
          continue;
        }

        if (
          sseEvent.type === "response.code_interpreter_call_code.done" ||
          sseEvent.type === "response.mcp_call_arguments.done"
        ) {
          // 完整 code/args 会在 output_item.done 上写入 call；此处忽略避免重复 delta
          continue;
        }

        // server tool progress events — known & ignored (terminal mapping on output_item.done)
        if (
          sseEvent.type === "response.web_search_call.in_progress" ||
          sseEvent.type === "response.web_search_call.searching" ||
          sseEvent.type === "response.web_search_call.completed" ||
          sseEvent.type === "response.code_interpreter_call.in_progress" ||
          sseEvent.type === "response.code_interpreter_call.interpreting" ||
          sseEvent.type === "response.code_interpreter_call.completed" ||
          sseEvent.type === "response.mcp_call.in_progress" ||
          sseEvent.type === "response.mcp_call.completed" ||
          sseEvent.type === "response.mcp_call.failed" ||
          sseEvent.type === "response.mcp_list_tools.in_progress" ||
          sseEvent.type === "response.mcp_list_tools.completed" ||
          sseEvent.type === "response.mcp_list_tools.failed"
        ) {
          continue;
        }

        // Modern OpenAI reasoning summary text (publicly streamed for o-series / gpt-5)
        if (sseEvent.type === "response.reasoning_summary_text.delta") {
          const data = sseEvent.data as { item_id: string; delta: string };
          const state = ensureReasoningState(data.item_id, "summary");
          if (state.visibility === "opaque") state.visibility = "summary";
          if (data.delta) {
            state.hasDelta = true;
            yield factory.reasoningDelta(data.item_id, textBlock(data.delta));
          }
          continue;
        }

        if (sseEvent.type === "response.reasoning_summary_text.done") {
          const data = sseEvent.data as { item_id: string; text: string };
          const state = ensureReasoningState(data.item_id, "summary");
          if (state.visibility === "opaque") state.visibility = "summary";
          if (!state.hasDelta && data.text) {
            state.doneTexts.push(data.text);
            yield factory.reasoningDelta(data.item_id, textBlock(data.text));
          } else if (data.text) {
            state.doneTexts.push(data.text);
          }
          continue;
        }

        // Full reasoning text (opt-in via include); upgrade visibility to full
        if (sseEvent.type === "response.reasoning_text.delta") {
          const data = sseEvent.data as { item_id: string; delta: string };
          const state = ensureReasoningState(data.item_id, "full");
          state.visibility = "full";
          if (data.delta) {
            state.hasDelta = true;
            yield factory.reasoningDelta(data.item_id, textBlock(data.delta));
          }
          continue;
        }

        if (sseEvent.type === "response.reasoning_text.done") {
          const data = sseEvent.data as { item_id: string; text: string };
          const state = ensureReasoningState(data.item_id, "full");
          state.visibility = "full";
          if (!state.hasDelta && data.text) {
            state.doneTexts.push(data.text);
            yield factory.reasoningDelta(data.item_id, textBlock(data.text));
          } else if (data.text) {
            state.doneTexts.push(data.text);
          }
          continue;
        }

        // Structural summary part events — known & ignored (text is handled above)
        if (
          sseEvent.type === "response.reasoning_summary_part.added" ||
          sseEvent.type === "response.reasoning_summary_part.done"
        ) {
          continue;
        }

        // Legacy aliases kept for fixtures / older gateways
        if (sseEvent.type === "response.reasoning.delta") {
          const data = sseEvent.data as { item_id: string; delta: string };
          const state = ensureReasoningState(data.item_id, "full");
          state.visibility = "full";
          if (data.delta) {
            state.hasDelta = true;
            yield factory.reasoningDelta(data.item_id, textBlock(data.delta));
          }
          continue;
        }

        if (sseEvent.type === "response.reasoning.done") {
          const data = sseEvent.data as { item_id: string; text: string };
          const state = ensureReasoningState(data.item_id, "full");
          if (!state.hasDelta && data.text) {
            yield factory.reasoningDelta(data.item_id, textBlock(data.text));
          }
          yield* completeReasoning(data.item_id, data.text ?? state.doneTexts.join("\n"), "full");
          continue;
        }

        if (sseEvent.type === "response.function_call_arguments.delta") {
          const data = sseEvent.data as { item_id: string; delta: string };
          if (data.delta) {
            yield factory.toolCallDelta(resolveToolCallId(data.item_id), { argumentsText: data.delta });
          }
          continue;
        }

        if (sseEvent.type === "response.function_call_arguments.done") {
          const data = sseEvent.data as { item_id: string; arguments: string };
          const callId = resolveToolCallId(data.item_id);
          // 若 added 事件缺失，done 时仍尽量从 completed payload 之外兜底 call_id
          if (!toolCallIds.has(data.item_id)) toolCallIds.set(data.item_id, callId);
          const tcItem = toolCallItem(callId, toolCallNames.get(data.item_id) ?? "unknown", data.arguments);
          yield factory.toolCallCompleted(callId);
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

          // Safety net: finalize any still-open reasoning items from the final response payload.
          if (Array.isArray(data.response.output)) {
            for (const item of data.response.output) {
              if (item?.type !== "reasoning" || !item.id) continue;
              const state = reasoningStates.get(item.id);
              if (state?.completed) continue;
              const extracted = extractReasoningFromOutputItem(item);
              const text =
                extracted.text ||
                (state && state.doneTexts.length > 0 ? state.doneTexts.join("\n") : "");
              // Only complete if we already started this item (otherwise aggregator has no active item).
              if (state || reasoningStates.has(item.id)) {
                yield* completeReasoning(item.id, text, extracted.visibility);
              }
            }
          }

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
    }

    let rawResponseId: string | undefined;
    if (completedResponse) {
      rawResponseId = completedResponse.id;
      if (completedResponse.usage) {
        auxiliary.recordUsage(usageFromOpenAIResponses(completedResponse.usage), "final", completedResponse.usage);
      }
    }

    const replay = [...replayFromOutput(output)];
    if (completedResponse?.id) {
      // 同时保留 id（向后兼容）与 previous_response_id（语义明确）
      replay.push(
        opaqueItem("responses", "replay", {
          id: completedResponse.id,
          previous_response_id: completedResponse.id,
        }),
      );
    }

    const stopReason = completedResponse ? this.inferStopReason(completedResponse) : undefined;

    if (gate.tryComplete()) {
      yield* this.emitStreamCompleted(factory, request, auxiliary, {
        output,
        replay,
        stopReason,
        rawResponseId,
      });
    }
  }

  // ── 辅助方法 ──────────────────────────────────────────────

  private inferStopReason(response: ResponsesAPIResponse): StopReason {
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
