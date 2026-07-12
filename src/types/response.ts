/**
 * AIResponse — 统一终结结果模型
 *
 * 流结束后由聚合器产出，用于承载当前轮的规范化输出、replay 材料及辅助信息。
 */

import type { OutputItem, ReplayItem, ToolCallItem } from "./items.js";

// ── StopReason ────────────────────────────────────────────────

export type StopReason = "end_turn" | "tool_call" | "max_output_tokens" | "content_filter" | "error" | "unknown";

// ── 辅助信息类型 ──────────────────────────────────────────────

export type Usage = {
  /** Provider prompt / input token count */
  inputTokens?: number;
  /** Provider completion / output token count */
  outputTokens?: number;
  /** Reasoning tokens when provider exposes output breakdown (e.g. OpenAI Responses) */
  reasoningTokens?: number;
  totalTokens?: number;
  /** Tokens read from prompt cache (OpenAI cached_tokens, Anthropic cache_read_input_tokens) */
  cachedInputTokens?: number;
  /** Tokens written to prompt cache (Anthropic cache_creation_input_tokens) */
  cacheWriteInputTokens?: number;

};

export type BillingInfo = {
  amount?: number;
  currency?: string;
  isEstimated: boolean;
  source: "provider" | "lookup" | "derived" | "unknown";
  raw?: unknown;
};

export type AuxiliaryInfo = {
  usageSource?: "stream" | "final" | "header" | "lookup" | "derived";
  billingSource?: "stream" | "final" | "header" | "lookup" | "derived";
  providerUsage?: unknown;
  providerBilling?: unknown;
  providerMetadata?: Record<string, unknown>;
};

export type BackendTrace = {
  requestId?: string;
  rawResponseId?: string;
  adapter: "chat-completions" | "messages" | "responses" | "ollama" | "mock";
  isSyntheticStream: boolean;
  metadataSources?: string[];
  warnings?: string[];
};

// ── 统一响应 ──────────────────────────────────────────────────

export type AIResponse = {
  id?: string;
  output: OutputItem[];
  replay: ReplayItem[];
  text: string;
  toolCalls: ToolCallItem[];
  stopReason?: StopReason;
  usage?: Usage;
  billing?: BillingInfo;
  auxiliary?: AuxiliaryInfo;
  warnings?: string[];
  backend: BackendTrace;
};
