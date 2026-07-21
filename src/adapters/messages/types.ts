/**
 * MessagesAdapter wire / options 类型
 */

import type { HttpAdapterOptions } from "../../provider/http-adapter.js";

/** apiKey 必填；默认 baseUrl https://api.anthropic.com/v1 */
export type MessagesAdapterOptions = HttpAdapterOptions & {
  apiKey: string;
  /** Anthropic API 版本头，默认 2023-06-01 */
  apiVersion?: string;
};

// ── Messages API 请求类型 ────────────────────────────────────

export type MessagesAPIRequest = {
  model: string;
  max_tokens: number;
  messages: MessagesAPIMessage[];
  system?: string;
  tools?: MessagesAPITool[];
  tool_choice?: { type: "auto" | "none" } | { type: "tool"; name: string };
  temperature?: number;
  thinking?: { type: "enabled"; budget_tokens: number } | { type: "disabled" };
  stream: true;
};

export type MessagesAPIMessage = {
  role: "user" | "assistant";
  content: string | MessagesAPIContentBlock[];
};

export type MessagesAPIContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | MessagesAPIContentBlock[]; is_error?: boolean };

export type MessagesAPITool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};
