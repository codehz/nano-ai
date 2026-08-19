import { describe, expect, it } from "bun:test";
import { buildChatCompletionsRequest } from "../../src/adapters/chat-completions/map-request.js";
import { buildGeminiRequest } from "../../src/adapters/gemini/map-request.js";
import { buildMessagesRequest } from "../../src/adapters/messages/map-request.js";
import { buildOllamaRequest } from "../../src/adapters/ollama/map-request.js";
import { buildResponsesRequest } from "../../src/adapters/responses/map-request.js";
import { applyPromptCacheFields, promptCacheMetadata } from "../../src/provider/prompt-cache.js";
import type { NormalizedRequest } from "../../src/types/index.js";

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    model: "test-model",
    requestId: "test-request",
    input: [],
    ...overrides,
  };
}

describe("prompt cache mapping", () => {
  it("maps portable explicit controls to Responses", () => {
    const body = buildResponsesRequest(request({ cache: { mode: "explicit", key: "session-1", ttl: "long" } }));

    expect(body.prompt_cache_key).toBe("session-1");
    expect(body.prompt_cache_options).toEqual({ mode: "explicit", retention: "24h" });
  });

  it("maps provider-native controls to Chat Completions", () => {
    const body = buildChatCompletionsRequest(
      request({
        providerOptions: {
          cache: {
            chatCompletions: {
              promptCacheKey: "native-key",
              promptCacheRetention: "in_memory",
            },
          },
        },
      }),
    );

    expect(body.prompt_cache_key).toBe("native-key");
    expect(body.prompt_cache_retention).toBe("in_memory");
  });

  it("maps Anthropic explicit cache breakpoints onto the stable prefix", () => {
    const body = buildMessagesRequest(
      request({
        instructions: "Be concise.",
        cache: { mode: "explicit", ttl: "long" },
      }),
    );

    expect(body.system).toEqual([
      {
        type: "text",
        text: "Be concise.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });

  it("maps typed Gemini and Ollama cache options", () => {
    const gemini = buildGeminiRequest(
      request({ providerOptions: { cache: { gemini: { cachedContent: "cachedContents/1" } } } }),
    );
    const ollama = buildOllamaRequest(request({ providerOptions: { cache: { ollama: { keepAlive: "10m" } } } }));

    expect(gemini.cachedContent).toBe("cachedContents/1");
    expect(ollama.keep_alive).toBe("10m");
  });

  it("omits portable fields for off mode", () => {
    const body = buildResponsesRequest(request({ cache: { mode: "off", key: "ignored", ttl: "long" } }));

    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.prompt_cache_options).toBeUndefined();
  });

  it("reports applied and unsupported states for audit metadata", () => {
    expect(promptCacheMetadata(request({ cache: { mode: "explicit" } }), "gemini")).toEqual({
      requestedMode: "explicit",
      appliedMode: "unsupported",
      keyApplied: false,
      ttlApplied: false,
    });

    const body: Record<string, unknown> = {};
    const metadata = applyPromptCacheFields(
      body,
      request({ cache: { mode: "explicit", key: "key-1", ttl: "short" } }),
      "responses",
    );
    expect(metadata).toEqual({
      requestedMode: "explicit",
      appliedMode: "explicit",
      keyApplied: true,
      ttlApplied: true,
    });
  });
});
