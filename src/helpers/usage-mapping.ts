/**
 * Provider usage → canonical Usage 映射
 *
 * best-effort 提取 reasoning / cache 等扩展字段。
 */

import type { Usage } from "../types/index.js";

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(obj: Record<string, number | undefined>): Partial<Usage> {
  const out: Partial<Usage> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (out as Record<string, number>)[key] = value;
    }
  }
  return out;
}

/** OpenAI Chat Completions `usage` */
export function usageFromChatCompletions(raw: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; [key: string]: unknown };
  completion_tokens_details?: { reasoning_tokens?: number; [key: string]: unknown };
}): Partial<Usage> {
  const inputTokens = num(raw.prompt_tokens);
  const outputTokens = num(raw.completion_tokens);
  const cachedInputTokens = num(raw.prompt_tokens_details?.cached_tokens);
  const reasoningTokens = num(raw.completion_tokens_details?.reasoning_tokens);
  const totalTokens =
    num(raw.total_tokens) ??
    (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);

  return record({
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningTokens,
  });
}

/** OpenAI Responses API `usage` */
export function usageFromOpenAIResponses(raw: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; [key: string]: unknown };
  output_tokens_details?: { reasoning_tokens?: number; [key: string]: unknown };
  [key: string]: unknown;
}): Partial<Usage> {
  const inputTokens = num(raw.input_tokens);
  const outputTokens = num(raw.output_tokens);
  const cachedInputTokens = num(raw.input_tokens_details?.cached_tokens);
  const reasoningTokens = num(raw.output_tokens_details?.reasoning_tokens);
  const totalTokens =
    num(raw.total_tokens) ??
    (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);

  return record({
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningTokens,
  });
}

/** Anthropic Messages `usage`（message_start / message_delta） */
export function usageFromAnthropicMessages(raw: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}): Partial<Usage> {
  const uncachedInputTokens = num(raw.input_tokens);
  const outputTokens = num(raw.output_tokens);
  const cacheWriteInputTokens = num(raw.cache_creation_input_tokens);
  const cachedInputTokens = num(raw.cache_read_input_tokens);

  const inputParts = [uncachedInputTokens, cacheWriteInputTokens, cachedInputTokens].filter(
    (n): n is number => n !== undefined,
  );
  const inputTokens = inputParts.length > 0 ? inputParts.reduce((sum, n) => sum + n, 0) : undefined;
  const totalTokens = inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined;

  return record({
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
  });
}

/** Ollama 流式 chunk */
export function usageFromOllama(raw: { prompt_eval_count?: number; eval_count?: number }): Partial<Usage> {
  const inputTokens = num(raw.prompt_eval_count);
  const outputTokens = num(raw.eval_count);
  const totalTokens = inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined;

  return record({
    inputTokens,
    outputTokens,
    totalTokens,
  });
}
