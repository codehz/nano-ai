/**
 * ChatCompletionsAdapter wire / options 类型
 */

import type { FetchFn } from "../../types/index.js";

export type ChatCompletionsAdapterOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchFn;
  /** 额外请求头；后写覆盖内置 Authorization / Content-Type */
  headers?: Record<string, string>;
  /** 额外 body 顶层字段；浅层合并，同名键可覆盖 */
  extraBody?: Record<string, unknown>;
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
  id: string;
  name: string;
  args: string;
};

export type ReasoningFieldName = "reasoning" | "reasoning_content";

export const REASONING_FIELDS: readonly ReasoningFieldName[] = ["reasoning_content", "reasoning"];


