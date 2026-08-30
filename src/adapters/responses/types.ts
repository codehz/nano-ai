/**
 * ResponsesAdapter wire / options 类型
 */

import type { HttpAdapterOptions } from "../../provider/http-adapter.js";

/** apiKey 必填；默认 baseUrl https://api.openai.com/v1 */
export type ResponsesAdapterOptions = HttpAdapterOptions & {
  apiKey: string;
};

// ── Responses API 请求类型（对齐 OpenAI Responses schema）────
//
// input 是 untagged enum ModelInput = string | InputItem[]。
// 每个 InputItem 也必须命中官方 variant，否则会 422：
//   "data did not match any variant of untagged enum ModelInput"

/** OpenAI Responses API 的流式请求体。 */
export type ResponsesAPIRequest = {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: "auto" | "none" | { type: "function"; name: string };
  metadata?: Record<string, string>;
  temperature?: number;
  max_output_tokens?: number;
  /** Portable reasoningLevel → effort；summary 等特化字段不在此层 */
  reasoning?: { effort: string };
  /** Portable serviceTier → service_tier（auto / default / flex / fast / priority） */
  service_tier?: string;
  /** 服务端多轮续写；opaque replay 的 response id 映射到此字段，而非 item_reference */
  previous_response_id?: string;
  prompt_cache_key?: string;
  prompt_cache_options?: {
    mode?: "implicit" | "explicit" | "off";
    retention?: "in_memory" | "24h";
  };
  stream: true;
};

/**
 * POST /responses/compact 请求体（非流式）。
 * 仅保留 compact 相关字段；不设 stream / tools / temperature 等生成参数。
 */
/** POST /responses/compact 请求体。 */
export type ResponsesCompactAPIRequest = {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  previous_response_id?: string;
};

/** POST /responses/compact 响应体。 */
export type ResponsesCompactAPIResponse = {
  id?: string;
  object?: string;
  created_at?: number;
  output: Array<Record<string, unknown>>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; [key: string]: unknown };
    output_tokens_details?: { reasoning_tokens?: number; [key: string]: unknown };
    cache_write_tokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** Responses API 的消息输入 item。 */
export type ResponsesEasyMessage = {
  type: "message";
  role: "user" | "assistant" | "system" | "developer";
  content: string | ResponsesInputContentPart[];
};

/** Responses API 的输入内容 part。 */
export type ResponsesInputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "auto" | "low" | "high" }
  | { type: "input_file"; file_url?: string; file_id?: string; filename?: string };

/** Responses API 的客户端 function call item。 */
export type ResponsesFunctionCall = {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  id?: string;
  status?: "in_progress" | "completed" | "incomplete";
};

/** Responses API 的 function call 结果 item。 */
export type ResponsesFunctionCallOutput = {
  type: "function_call_output";
  call_id: string;
  output: string | ResponsesInputContentPart[];
  id?: string;
  status?: "in_progress" | "completed" | "incomplete";
};

/** reasoning：id + summary/content/encrypted_content，不是任意 content blocks */
export type ResponsesReasoningInput = {
  type: "reasoning";
  id: string;
  summary: Array<{ type: "summary_text"; text: string }>;
  content?: Array<{ type: "reasoning_text"; text: string }>;
  encrypted_content?: string | null;
  status?: "in_progress" | "completed" | "incomplete";
};

/** 引用既有 item（不是 response id） */
export type ResponsesItemReference = {
  type: "item_reference";
  id: string;
};

/** compact 输出中的加密 compaction 项（可原样回传为 input） */
export type ResponsesCompactionInput = {
  type: "compaction";
  id?: string;
  encrypted_content?: string;
  [key: string]: unknown;
};

/**
 * 保真透传的 wire item（compact window 中可能含 message/function_call/compaction 等）。
 * 用于 compacted_window 原样展开，不在此做严格 shape 收窄。
 */
export type ResponsesWirePassthroughItem = {
  type: string;
  [key: string]: unknown;
};

/** Responses API 可接受的输入 item 联合。 */
export type ResponsesInputItem =
  | ResponsesEasyMessage
  | ResponsesFunctionCall
  | ResponsesFunctionCallOutput
  | ResponsesReasoningInput
  | ResponsesItemReference
  | ResponsesCompactionInput
  | ResponsesWirePassthroughItem;

/** Responses API 的客户端 function 工具。 */
export type ResponsesFunctionTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean | null;
};

/** Responses API 的 Web Search 工具。 */
export type ResponsesWebSearchTool = {
  type: "web_search";
  filters?: {
    allowed_domains?: string[];
    blocked_domains?: string[];
  };
  user_location?: {
    type: "approximate";
    country?: string;
    city?: string;
    region?: string;
    timezone?: string;
  };
  search_context_size?: "low" | "medium" | "high";
};

/** Responses API 的代码解释器工具。 */
export type ResponsesCodeInterpreterTool = {
  type: "code_interpreter";
  container:
    | string
    | {
        type: "auto";
        memory_limit?: "1g" | "4g" | "16g" | "64g";
        file_ids?: string[];
      };
};

/** Responses API 的 MCP 工具。 */
export type ResponsesMcpTool = {
  type: "mcp";
  server_label: string;
  server_url: string;
  server_description?: string;
  authorization?: string;
  allowed_tools?: string[];
  require_approval: "never";
};

/** Responses API 的工具联合。 */
export type ResponsesTool =
  | ResponsesFunctionTool
  | ResponsesWebSearchTool
  | ResponsesCodeInterpreterTool
  | ResponsesMcpTool;

// ── Responses API 响应 / SSE 类型 ──────────────────────────────

/** Responses API 输出 item。 */
export type ResponsesAPIOutputItem = {
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

/** Responses API 响应体。 */
export type ResponsesAPIResponse = {
  id: string;
  model: string;
  output: ResponsesAPIOutputItem[];
  status?: "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete" | string;
  incomplete_details?: { reason?: string | null } | null;
  error?: { message?: string; code?: string } | null;
  failure?: { message?: string; code?: string } | null;
  service_tier?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** SSE 事件联合；末位 catch-all 兼容未知 type。 */
export type ResponsesSSEEvent =
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
