import { describe, expect, it } from "bun:test";
import {
  usageFromAnthropicMessages,
  usageFromChatCompletions,
  usageFromOllama,
  usageFromOpenAIResponses,
} from "../src/helpers/usage-mapping.js";

describe("usage-mapping", () => {
  it("maps OpenAI chat completions usage details", () => {
    const usage = usageFromChatCompletions({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 30 },
      completion_tokens_details: { reasoning_tokens: 10 },
    });

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      cachedInputTokens: 30,
      reasoningTokens: 10,
      billableInputTokens: 70,
      billableOutputTokens: 30,
    });
  });

  it("maps OpenAI responses usage details", () => {
    const usage = usageFromOpenAIResponses({
      input_tokens: 50,
      output_tokens: 20,
      total_tokens: 70,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens_details: { reasoning_tokens: 8 },
    });

    expect(usage.cachedInputTokens).toBe(5);
    expect(usage.reasoningTokens).toBe(8);
    expect(usage.billableInputTokens).toBe(45);
    expect(usage.billableOutputTokens).toBe(12);
  });

  it("maps Anthropic messages cache fields and total", () => {
    const usage = usageFromAnthropicMessages({
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 7,
    });

    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(4);
    expect(usage.cacheWriteInputTokens).toBe(3);
    expect(usage.cachedInputTokens).toBe(7);
    expect(usage.totalTokens).toBe(24);
    expect(usage.billableInputTokens).toBe(13);
    expect(usage.billableOutputTokens).toBe(4);
  });

  it("maps Ollama counts with billable mirrors", () => {
    expect(usageFromOllama({ prompt_eval_count: 15, eval_count: 5 })).toEqual({
      inputTokens: 15,
      outputTokens: 5,
      totalTokens: 20,
      billableInputTokens: 15,
      billableOutputTokens: 5,
    });
  });
});