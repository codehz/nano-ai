/**
 * Adapter 共享映射 helper
 *
 * 提供 adapter 间通用的类型映射函数：
 * - stop reason 映射
 * - content block 映射
 * - item 映射
 * - warning 记录
 * - replay 构造工具
 */

import type {
  StopReason,
  ContentBlock,
  MessageItem,
  ReasoningItem,
  ToolCallItem,
  ToolResultItem,
  OpaqueItem,
  InputItem,
  OutputItem,
  ReplayItem,
} from "../types/index.js";

// ── Stop reason 映射 ──────────────────────────────────────────

/**
 * 常见 provider stop_reason / finish_reason 到 canonical StopReason 的映射表。
 * adapter 可先查此表，未覆盖时走 fallback 规则。
 */
const STOP_REASON_MAP: Record<string, StopReason> = {
  // OpenAI / Azure
  stop: "end_turn",
  length: "max_output_tokens",
  content_filter: "content_filter",
  tool_calls: "tool_call",
  // Anthropic
  end_turn: "end_turn",
  max_tokens: "max_output_tokens",
  tool_use: "tool_call",
  // Generic
  error: "error",
};

export function mapStopReason(providerReason: string): StopReason {
  return STOP_REASON_MAP[providerReason] ?? "unknown";
}

// ── Reasoning visibility 映射 ──────────────────────────────────

export function mapReasoningVisibility(
  hasThinking: boolean,
  hasRedacted: boolean,
): ReasoningItem["visibility"] {
  if (hasRedacted) return "redacted";
  if (hasThinking) return "full";
  return "opaque";
}

// ── Content block 构造 helper ─────────────────────────────────

export function textBlock(text: string): ContentBlock & { type: "text" } {
  return { type: "text", text };
}

export function jsonBlock(json: unknown): ContentBlock & { type: "json" } {
  return { type: "json", json };
}

export function imageBlock(imageUrl: string): ContentBlock & { type: "image" } {
  return { type: "image", imageUrl };
}

export function opaqueBlock(payload: unknown): ContentBlock & { type: "opaque" } {
  return { type: "opaque", payload };
}

// ── Item 构造 helper ──────────────────────────────────────────

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

export function toolCallItem(
  id: string,
  name: string,
  argumentsText: string,
  argumentsJson?: unknown,
): ToolCallItem {
  return {
    type: "tool_call",
    id,
    name,
    argumentsText,
    argumentsJson,
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

// ── Replay 构造工具 ──────────────────────────────────────────

/**
 * 从 output items 构建标准 replay items。
 * 简单场景下 replay 与 output 一致。
 * 复杂场景（需要 opaque continuation）由 adapter 自行扩展。
 */
export function replayFromOutput(output: readonly OutputItem[]): ReplayItem[] {
  return output.map((item): InputItem => {
    switch (item.type) {
      case "message":
      case "reasoning":
      case "tool_call":
        return item as InputItem;
      case "opaque":
        return item;
    }
  });
}
