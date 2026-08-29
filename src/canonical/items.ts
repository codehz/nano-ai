/**
 * Canonical item 构造 helper
 */

import type {
  ContentBlock,
  MessageItem,
  OpaqueItem,
  ReasoningItem,
  ServerToolCallItem,
  ServerToolDiscoveryItem,
  ServerToolResultItem,
  ToolCallItem,
  ToolResultItem,
} from "../types/index.js";

/** 创建消息 item；可用 overrides 补充 id、role 和 citations。 */
export function messageItem(
  content: ContentBlock[],
  overrides?: Partial<Omit<MessageItem, "type" | "content">>,
): MessageItem {
  return {
    type: "message",
    role: "assistant",
    ...overrides,
    content,
  };
}

/** 创建 reasoning item。 */
export function reasoningItem(
  content: ContentBlock[],
  visibility: ReasoningItem["visibility"] = "full",
  id?: string,
): ReasoningItem {
  return {
    type: "reasoning",
    id,
    visibility,
    content,
  };
}

/** 创建客户端工具调用 item。 */
export function toolCallItem(id: string, name: string, argumentsText: string): ToolCallItem {
  return {
    type: "tool_call",
    id,
    name,
    argumentsText,
  };
}

/** 创建客户端工具结果 item。 */
export function toolResultItem(
  callId: string,
  toolName: string,
  outcome: ToolResultItem["outcome"],
  content: ContentBlock[],
): ToolResultItem {
  return {
    type: "tool_result",
    callId,
    toolName,
    outcome,
    content,
  };
}

/** 创建 opaque item，通常用于 provider replay。 */
export function opaqueItem(
  source: OpaqueItem["source"],
  purpose: OpaqueItem["purpose"],
  payload: unknown,
  id?: string,
): OpaqueItem {
  return {
    type: "opaque",
    id,
    source,
    purpose,
    payload,
  };
}

/** 创建 provider 托管工具调用 item。 */
export function serverToolCallItem(
  id: string,
  tool: ServerToolCallItem["tool"],
  overrides?: Partial<Omit<ServerToolCallItem, "type" | "id" | "tool">>,
): ServerToolCallItem {
  return {
    type: "server_tool_call",
    id,
    tool,
    ...overrides,
  };
}

/** 创建 provider 托管工具结果 item。 */
export function serverToolResultItem(
  callId: string,
  tool: string,
  outcome: ServerToolResultItem["outcome"],
  content: ContentBlock[],
  overrides?: Partial<Omit<ServerToolResultItem, "type" | "callId" | "tool" | "outcome" | "content">>,
): ServerToolResultItem {
  return {
    type: "server_tool_result",
    callId,
    tool,
    outcome,
    content,
    ...overrides,
  };
}

/** 创建 MCP 等 provider 托管工具发现 item。 */
export function serverToolDiscoveryItem(
  id: string,
  serverLabel: string,
  tools: ServerToolDiscoveryItem["tools"],
  overrides?: Partial<Omit<ServerToolDiscoveryItem, "type" | "id" | "tool" | "serverLabel" | "tools">>,
): ServerToolDiscoveryItem {
  return {
    type: "server_tool_discovery",
    id,
    tool: "mcp",
    serverLabel,
    tools,
    ...overrides,
  };
}
