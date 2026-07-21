/**
 * MessagesAdapter wire / options 类型
 */

import type { FetchFn } from "../../types/index.js";

export type MessagesAdapterOptions = {
  apiKey: string;
  apiVersion?: string;
  baseUrl?: string;
  /** 可注入自定义 fetch 实现（用于测试／代理） */
  fetch?: FetchFn;
  /** 额外请求头；后写覆盖内置 x-api-key / Content-Type / anthropic-version */
  headers?: Record<string, string>;
  /** 额外 body 顶层字段；浅层合并，同名键可覆盖 */
  extraBody?: Record<string, unknown>;
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
