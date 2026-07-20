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

export function toolCallItem(id: string, name: string, argumentsText: string): ToolCallItem {
  return {
    type: "tool_call",
    id,
    name,
    argumentsText,
  };
}

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
