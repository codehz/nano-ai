/**
 * Canonical Item 类型体系
 *
 * 覆盖统一请求/响应中的所有 item 类型。
 */

import type { ContentBlock } from "./content.js";

// ── Citations ─────────────────────────────────────────────────

export type UrlCitation = {
  type: "url";
  url: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
};

export type ContainerFileCitation = {
  type: "container_file";
  containerId: string;
  fileId: string;
  filename?: string;
  startIndex?: number;
  endIndex?: number;
};

export type Citation = UrlCitation | ContainerFileCitation;

// ── Input item types ──────────────────────────────────────────

export type MessageItem = {
  type: "message";
  id?: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  citations?: Citation[];
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

/** Provider 托管工具调用（调用方不执行） */
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

/** Provider 托管工具结果 */
export type ServerToolResultItem = {
  type: "server_tool_result";
  id?: string;
  callId: string;
  tool: string;
  outcome: "success" | "error";
  content: ContentBlock[];
  providerPayload?: unknown;
};

/** MCP 等远端工具发现列表 */
export type ServerToolDiscoveryItem = {
  type: "server_tool_discovery";
  id: string;
  tool: "mcp";
  serverLabel: string;
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  providerPayload?: unknown;
};

// ── Aliases ───────────────────────────────────────────────────

/** 可出现在请求 input 中的 item 类型 */
export type InputItem =
  | MessageItem
  | ReasoningItem
  | ToolCallItem
  | ToolResultItem
  | OpaqueItem
  | ServerToolCallItem
  | ServerToolResultItem
  | ServerToolDiscoveryItem;

/** 可出现在响应 output 中的 item 类型（不含客户端 ToolResultItem） */
export type OutputItem =
  | MessageItem
  | ReasoningItem
  | ToolCallItem
  | OpaqueItem
  | ServerToolCallItem
  | ServerToolResultItem
  | ServerToolDiscoveryItem;

/** replay 材料的类型等价于 InputItem */
export type ReplayItem = InputItem;
