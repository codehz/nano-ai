/**
 * ChatCompletionsAdapter wire / options 类型
 */

import type { HttpAdapterOptions } from "../../provider/http-adapter.js";

/** apiKey 必填；默认 baseUrl https://api.openai.com/v1 */
export type ChatCompletionsAdapterOptions = HttpAdapterOptions & {
  apiKey: string;
};

// ── Chat API 请求类型 ─────────────────────────────────────────

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  metadata?: Record<string, string>;
  temperature?: number;
  max_tokens?: number;
  /** Portable reasoningLevel → reasoning_effort */
  reasoning_effort?: string;
  stream: true;
  n: 1;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
  [key: string]: unknown;
};

export type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatTool = {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
};

// ── SSE chunk 类型 ────────────────────────────────────────────

export type ChatChunk = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChunkChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
};

export type ChatChunkChoice = {
  index: number;
  delta: {
    role?: string;
    content?: string | null;
    reasoning?: unknown;
    reasoning_content?: unknown;
    tool_calls?: ChatChunkToolCall[];
    function_call?: { name?: string; arguments?: string };
    [key: string]: unknown;
  };
  finish_reason?: string | null;
};

export type ChatChunkToolCall = {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

export type PendingToolCall = {
  /** 真实 call id；未到 id 前用合成占位 id */
  id: string;
  name: string;
  args: string;
  /** 是否已向 StreamingItemSession 发出 startToolCall */
  started: boolean;
  /** 是否已收到 provider 的真实 id */
  hasProviderId: boolean;
};

export type ReasoningFieldName = "reasoning" | "reasoning_content";

export const REASONING_FIELDS: readonly ReasoningFieldName[] = ["reasoning_content", "reasoning"];
