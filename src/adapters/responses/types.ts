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
  /** 服务端多轮续写；opaque replay 的 response id 映射到此字段，而非 item_reference */
  previous_response_id?: string;
  stream: true;
};

/** EasyInputMessage：content 可为 string，或 input_* content parts */
export type ResponsesEasyMessage = {
  type: "message";
  role: "user" | "assistant" | "system" | "developer";
  content: string | ResponsesInputContentPart[];
};

export type ResponsesInputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "auto" | "low" | "high" }
  | { type: "input_file"; file_url?: string; file_id?: string; filename?: string };

/** function_call：call_id 必填；id 是可选的 item id */
export type ResponsesFunctionCall = {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  id?: string;
  status?: "in_progress" | "completed" | "incomplete";
};

export type ResponsesFunctionCallOutput = {
  type: "function_call_output";
  call_id: string;
  output: string;
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

export type ResponsesInputItem =
  | ResponsesEasyMessage
  | ResponsesFunctionCall
  | ResponsesFunctionCallOutput
  | ResponsesReasoningInput
  | ResponsesItemReference;

export type ResponsesFunctionTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean | null;
};

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

export type ResponsesMcpTool = {
  type: "mcp";
  server_label: string;
  server_url: string;
  server_description?: string;
  authorization?: string;
  allowed_tools?: string[];
  require_approval: "never";
};

/** Responses API tools 联合：客户端 function + 内置 server tools */
export type ResponsesTool =
  | ResponsesFunctionTool
  | ResponsesWebSearchTool
  | ResponsesCodeInterpreterTool
  | ResponsesMcpTool;
