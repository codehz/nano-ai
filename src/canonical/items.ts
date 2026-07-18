/**
 * Canonical item 构造 helper
 */

import type {
  ContentBlock,
  MessageItem,
  OpaqueItem,
  ReasoningItem,
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
