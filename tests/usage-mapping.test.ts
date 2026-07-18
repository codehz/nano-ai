import { describe, expect, it } from "bun:test";
import {
  usageFromAnthropicMessages,
  usageFromChatCompletions,
  usageFromGemini,
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
  });

  it("maps Anthropic messages cache fields and total", () => {
    const usage = usageFromAnthropicMessages({
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 7,
    });

    expect(usage.inputTokens).toBe(20);
    expect(usage.outputTokens).toBe(4);
    expect(usage.cacheWriteInputTokens).toBe(3);
    expect(usage.cachedInputTokens).toBe(7);
    expect(usage.totalTokens).toBe(24);
    expect(usage.inputTokens! + usage.outputTokens!).toBe(usage.totalTokens!);
  });

  it("maps Anthropic messages without cache fields", () => {
    const usage = usageFromAnthropicMessages({
      input_tokens: 10,
      output_tokens: 4,
    });

    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(4);
    expect(usage.totalTokens).toBe(14);
    expect(usage.cachedInputTokens).toBeUndefined();
    expect(usage.cacheWriteInputTokens).toBeUndefined();
    expect(usage.inputTokens! + usage.outputTokens!).toBe(usage.totalTokens!);
  });

  it("maps Anthropic messages with cache reads only", () => {
    const usage = usageFromAnthropicMessages({
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 7,
    });

    expect(usage.inputTokens).toBe(17);
    expect(usage.cachedInputTokens).toBe(7);
    expect(usage.cacheWriteInputTokens).toBeUndefined();
    expect(usage.totalTokens).toBe(21);
    expect(usage.inputTokens! + usage.outputTokens!).toBe(usage.totalTokens!);
  });

  it("maps Anthropic messages with cache writes only", () => {
    const usage = usageFromAnthropicMessages({
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 3,
    });

    expect(usage.inputTokens).toBe(13);
    expect(usage.cachedInputTokens).toBeUndefined();
    expect(usage.cacheWriteInputTokens).toBe(3);
    expect(usage.totalTokens).toBe(17);
    expect(usage.inputTokens! + usage.outputTokens!).toBe(usage.totalTokens!);
  });

  it("maps Anthropic messages with partial fields (no output)", () => {
    const usage = usageFromAnthropicMessages({
      input_tokens: 10,
      cache_read_input_tokens: 5,
    });

    expect(usage.inputTokens).toBe(15);
    expect(usage.outputTokens).toBeUndefined();
    expect(usage.totalTokens).toBeUndefined();
  });

  it("maps Anthropic messages with missing field", () => {
    const usage = usageFromAnthropicMessages({});

    expect(usage.inputTokens).toBeUndefined();
    expect(usage.outputTokens).toBeUndefined();
    expect(usage.totalTokens).toBeUndefined();
  });

  it("maps Gemini usageMetadata", () => {
    expect(
      usageFromGemini({
        promptTokenCount: 20,
        candidatesTokenCount: 5,
        totalTokenCount: 32,
        cachedContentTokenCount: 4,
        thoughtsTokenCount: 7,
      }),
    ).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 32,
      cachedInputTokens: 4,
      reasoningTokens: 7,
    });
  });

  it("maps Ollama counts", () => {
    expect(usageFromOllama({ prompt_eval_count: 15, eval_count: 5 })).toEqual({
      inputTokens: 15,
      outputTokens: 5,
      totalTokens: 20,
    });
  });

  it("inputTokens + outputTokens === totalTokens across all adapters", () => {
    const openaiCC = usageFromChatCompletions({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 30 },
      completion_tokens_details: { reasoning_tokens: 10 },
    });
    expect(openaiCC.inputTokens! + openaiCC.outputTokens!).toBe(openaiCC.totalTokens!);

    const openaiResp = usageFromOpenAIResponses({
      input_tokens: 50,
      output_tokens: 20,
      total_tokens: 70,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens_details: { reasoning_tokens: 8 },
    });
    expect(openaiResp.inputTokens! + openaiResp.outputTokens!).toBe(openaiResp.totalTokens!);

    const ollama = usageFromOllama({ prompt_eval_count: 15, eval_count: 5 });
    expect(ollama.inputTokens! + ollama.outputTokens!).toBe(ollama.totalTokens!);
  });
});
