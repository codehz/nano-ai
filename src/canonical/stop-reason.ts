/**
 * Stop reason / reasoning visibility 映射
 */

import type { ReasoningItem, StopReason } from "../types/index.js";

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
  // Gemini GenerateContent finishReason
  STOP: "end_turn",
  MAX_TOKENS: "max_output_tokens",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  MALFORMED_FUNCTION_CALL: "error",
  UNEXPECTED_TOOL_CALL: "error",
  TOO_MANY_TOOL_CALLS: "error",
  MISSING_THOUGHT_SIGNATURE: "error",
  // Generic
  error: "error",
};

export function mapStopReason(providerReason: string): StopReason {
  return STOP_REASON_MAP[providerReason] ?? "unknown";
}

export function mapReasoningVisibility(hasThinking: boolean, hasRedacted: boolean): ReasoningItem["visibility"] {
  if (hasRedacted) return "redacted";
  if (hasThinking) return "full";
  return "opaque";
}
