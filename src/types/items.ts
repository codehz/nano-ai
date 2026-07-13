/**
 * Canonical Item 类型体系
 *
 * 覆盖统一请求/响应中的所有 item 类型。
 */

import type { ContentBlock } from "./content.js";

// ── Input item types ──────────────────────────────────────────

export type MessageItem = {
  type: "message";
  id?: string;
  role: "user" | "assistant";
  content: ContentBlock[];
};

export type ReasoningItem = {
  type: "reasoning";
  id?: string;
  visibility: "full" | "summary" | "redacted" | "opaque";
  content: ContentBlock[];
};

export type ToolCallItem = {
  type: "tool_call";
  id: string;
  name: string;
  argumentsText: string;
};

export type ToolResultItem = {
  type: "tool_result";
  callId: string;
  toolName: string;
  outcome: "success" | "error" | "rejected";
  content: ContentBlock[];
};

export type OpaqueItem = {
  type: "opaque";
  id?: string;
  source: "responses" | "messages" | "chat.completions" | string;
  purpose: "replay" | "provider_state" | "unknown";
  payload: unknown;
};

// ── Aliases ───────────────────────────────────────────────────

/** 可出现在请求 input 中的 item 类型 */
export type InputItem = MessageItem | ReasoningItem | ToolCallItem | ToolResultItem | OpaqueItem;

/** 可出现在响应 output 中的 item 类型（不含 ToolResultItem） */
export type OutputItem = MessageItem | ReasoningItem | ToolCallItem | OpaqueItem;

/** replay 材料的类型等价于 InputItem */
export type ReplayItem = InputItem;
