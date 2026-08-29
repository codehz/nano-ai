/**
 * Canonical Item 类型体系
 *
 * 覆盖统一请求/响应中的所有 item 类型。
 */

import type { ContentBlock } from "./content.js";

// ── Citations ─────────────────────────────────────────────────

/** URL 网页引用及其在原文中的可选位置。 */
export type UrlCitation = {
  type: "url";
  url: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
};

/** Provider 容器文件引用及其可选文件名和位置。 */
export type ContainerFileCitation = {
  type: "container_file";
  containerId: string;
  fileId: string;
  filename?: string;
  startIndex?: number;
  endIndex?: number;
};

/** 统一引用联合。 */
export type Citation = UrlCitation | ContainerFileCitation;

// ── Input item types ──────────────────────────────────────────

/** 文本或多模态消息 item。 */
export type MessageItem = {
  type: "message";
  id?: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  citations?: Citation[];
};

/** 模型 reasoning/thinking 内容及其可见性。 */
export type ReasoningItem = {
  type: "reasoning";
  id?: string;
  visibility: "full" | "summary" | "redacted" | "opaque";
  content: ContentBlock[];
};

/** 模型请求客户端工具调用。 */
export type ToolCallItem = {
  type: "tool_call";
  id: string;
  name: string;
  argumentsText: string;
};

/** 客户端工具调用结果。 */
export type ToolResultItem = {
  type: "tool_result";
  callId: string;
  toolName: string;
  outcome: "success" | "error" | "rejected";
  content: ContentBlock[];
};

/** Provider 专有状态或 wire replay 数据。 */
export type OpaqueItem = {
  type: "opaque";
  id?: string;
  source: "responses" | "messages" | "chat.completions" | string;
  purpose: "replay" | "provider_state" | "unknown";
  payload: unknown;
};

/** Provider 托管工具调用（调用方不执行）。 */
export type ServerToolCallItem = {
  type: "server_tool_call";
  id: string;
  tool: "web_search" | "code_execution" | "mcp" | string;
  name?: string;
  argumentsText?: string;
  status?: "in_progress" | "completed" | "failed";
  serverLabel?: string;
  providerPayload?: unknown;
};

/** Provider 托管工具结果。 */
export type ServerToolResultItem = {
  type: "server_tool_result";
  id?: string;
  callId: string;
  tool: string;
  outcome: "success" | "error";
  content: ContentBlock[];
  providerPayload?: unknown;
};

/** MCP 等远端工具发现列表。 */
export type ServerToolDiscoveryItem = {
  type: "server_tool_discovery";
  id: string;
  tool: "mcp";
  serverLabel: string;
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  providerPayload?: unknown;
};

// ── Aliases ───────────────────────────────────────────────────

/** 可出现在请求 input 中的 item 类型。 */
export type InputItem =
  | MessageItem
  | ReasoningItem
  | ToolCallItem
  | ToolResultItem
  | OpaqueItem
  | ServerToolCallItem
  | ServerToolResultItem
  | ServerToolDiscoveryItem;

/** 可出现在响应 output 中的 item 类型（不含客户端 ToolResultItem）。 */
export type OutputItem =
  | MessageItem
  | ReasoningItem
  | ToolCallItem
  | OpaqueItem
  | ServerToolCallItem
  | ServerToolResultItem
  | ServerToolDiscoveryItem;

/** replay 材料的类型等价于 InputItem。 */
export type ReplayItem = InputItem;
