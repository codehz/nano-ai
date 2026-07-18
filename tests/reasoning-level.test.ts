/**
 * reasoningLevel 映射 helper 单测
 */

import { describe, expect, it } from "bun:test";
import { AIRequestError } from "../src/index.js";
import { mapChatCompletionsReasoningEffort, mapGeminiThinking, mapMessagesThinking, mapMessagesThinkingBudget, mapOllamaThink, mapResponsesReasoning } from "../src/provider/reasoning.js";
describe("reasoning-level helpers", () => {
  it("maps Responses reasoning.effort 1:1", () => {
    expect(mapResponsesReasoning("high")).toEqual({ effort: "high" });
    expect(mapResponsesReasoning("none")).toEqual({ effort: "none" });
  });

  it("maps Chat Completions reasoning_effort 1:1", () => {
    expect(mapChatCompletionsReasoningEffort("minimal")).toBe("minimal");
    expect(mapChatCompletionsReasoningEffort("xhigh")).toBe("xhigh");
    expect(mapChatCompletionsReasoningEffort("max")).toBe("max");
  });

  it("maps Messages none to disabled", () => {
    expect(mapMessagesThinking("none", 4096)).toEqual({ type: "disabled" });
  });

  it("derives Messages budget with clamp floor 1024", () => {
    // low ≈ 10% of 4096 = 410 → clamp 1024
    expect(mapMessagesThinkingBudget("low", 4096)).toBe(1024);
    // medium ≈ 30% of 4096 = 1229
    expect(mapMessagesThinkingBudget("medium", 4096)).toBe(1229);
    // high ≈ 60% of 10000 = 6000
    expect(mapMessagesThinkingBudget("high", 10000)).toBe(6000);
  });

  it("clamps Messages budget below max_tokens", () => {
    // xhigh ≈ 90% of 1200 = 1080, upper = max(1024, 1199) = 1199
    expect(mapMessagesThinkingBudget("xhigh", 1200)).toBe(1080);
    // max ≈ 95% of 1200 = 1140
    expect(mapMessagesThinkingBudget("max", 1200)).toBe(1140);
    // tiny maxTokens: upper = max(1024, 0) = 1024, raw clamps to 1024 even if maxTokens is 1
    expect(mapMessagesThinkingBudget("minimal", 1)).toBe(1024);
  });

  it("maps Ollama supported levels and rejects unsupported", () => {
    expect(mapOllamaThink("none")).toBe(false);
    expect(mapOllamaThink("low")).toBe("low");
    expect(mapOllamaThink("medium")).toBe("medium");
    expect(mapOllamaThink("high")).toBe("high");

    expect(() => mapOllamaThink("minimal")).toThrow(AIRequestError);
    expect(() => mapOllamaThink("max")).toThrow(AIRequestError);
    try {
      mapOllamaThink("xhigh");
    } catch (err) {
      expect(err).toBeInstanceOf(AIRequestError);
      expect((err as AIRequestError).code).toBe("UNSUPPORTED_REASONING_LEVEL");
    }
  });

  it("maps Gemini thinkingConfig and rejects unsupported", () => {
    expect(mapGeminiThinking("none")).toEqual({ includeThoughts: false });
    expect(mapGeminiThinking("minimal")).toEqual({ includeThoughts: true, thinkingLevel: "MINIMAL" });
    expect(mapGeminiThinking("low")).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });
    expect(mapGeminiThinking("medium")).toEqual({ includeThoughts: true, thinkingLevel: "MEDIUM" });
    expect(mapGeminiThinking("high")).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });

    expect(() => mapGeminiThinking("xhigh")).toThrow(AIRequestError);
    try {
      mapGeminiThinking("max");
    } catch (err) {
      expect(err).toBeInstanceOf(AIRequestError);
      expect((err as AIRequestError).code).toBe("UNSUPPORTED_REASONING_LEVEL");
    }
  });
});
