/**
 * MessagesAdapter wire / options 类型
 */

import type { HttpAdapterOptions } from "../../provider/http-adapter.js";

/** Anthropic Messages adapter 配置；apiKey 必填，apiVersion 默认 2023-06-01。 */
export type MessagesAdapterOptions = HttpAdapterOptions & {
  apiKey: string;
  /** Anthropic API 版本头，默认 2023-06-01 */
  apiVersion?: string;
};

// ── Messages API 请求类型 ────────────────────────────────────

/** Anthropic Messages API 的流式请求体。 */
export type MessagesAPIRequest = {
  model: string;
  max_tokens: number;
  messages: MessagesAPIMessage[];
  system?: string | MessagesAPIContentBlock[];
  tools?: MessagesAPITool[];
  tool_choice?: { type: "auto" | "none" } | { type: "tool"; name: string };
  temperature?: number;
  thinking?: { type: "enabled"; budget_tokens: number } | { type: "disabled" };
  stream: true;
};

/** Anthropic Messages API 消息。 */
export type MessagesAPIMessage = {
  role: "user" | "assistant";
  content: string | MessagesAPIContentBlock[];
};

/** Anthropic 支持的图片媒体类型。 */
export type MessagesAPIImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** Anthropic 图片内容来源。 */
export type MessagesAPIImageSource =
  | { type: "base64"; media_type: MessagesAPIImageMediaType; data: string }
  | { type: "url"; url: string };

/** Anthropic prompt cache 控制。 */
export type MessagesCacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };

/** Anthropic 消息内容 block。 */
export type MessagesAPIContentBlock =
  | { type: "text"; text: string; cache_control?: MessagesCacheControl }
  | { type: "image"; source: MessagesAPIImageSource; cache_control?: MessagesCacheControl }
  | { type: "thinking"; thinking: string; signature?: string; cache_control?: MessagesCacheControl }
  | { type: "redacted_thinking"; data: string; cache_control?: MessagesCacheControl }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; cache_control?: MessagesCacheControl }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | MessagesAPIContentBlock[];
      is_error?: boolean;
      cache_control?: MessagesCacheControl;
    };

/** Anthropic 客户端工具声明。 */
export type MessagesAPITool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: MessagesCacheControl;
};
