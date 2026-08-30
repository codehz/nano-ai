/**
 * serviceTier 映射 helper 单测
 */

import { describe, expect, it } from "bun:test";
import { AIRequestError } from "../../src/index.js";
import {
  assertUnsupportedServiceTier,
  mapMessagesServiceTier,
  mapOpenAiServiceTier,
  serviceTierMetadata,
} from "../../src/provider/service-tier.js";

describe("service-tier helpers", () => {
  it("maps OpenAI service_tier 1:1 including fast and priority", () => {
    expect(mapOpenAiServiceTier("auto")).toBe("auto");
    expect(mapOpenAiServiceTier("default")).toBe("default");
    expect(mapOpenAiServiceTier("flex")).toBe("flex");
    expect(mapOpenAiServiceTier("fast")).toBe("fast");
    expect(mapOpenAiServiceTier("priority")).toBe("priority");
  });

  it("maps Messages auto/fast/priority to auto and default to standard_only", () => {
    expect(mapMessagesServiceTier("auto")).toBe("auto");
    expect(mapMessagesServiceTier("fast")).toBe("auto");
    expect(mapMessagesServiceTier("priority")).toBe("auto");
    expect(mapMessagesServiceTier("default")).toBe("standard_only");
  });

  it("rejects Messages flex", () => {
    expect(() => mapMessagesServiceTier("flex")).toThrow(AIRequestError);
    try {
      mapMessagesServiceTier("flex");
    } catch (err) {
      expect(err).toBeInstanceOf(AIRequestError);
      expect((err as AIRequestError).code).toBe("UNSUPPORTED_SERVICE_TIER");
    }
  });

  it("rejects serviceTier on adapters that do not support it", () => {
    expect(() => assertUnsupportedServiceTier(undefined, "ollama")).not.toThrow();
    expect(() => assertUnsupportedServiceTier("fast", "ollama")).toThrow(AIRequestError);
    try {
      assertUnsupportedServiceTier("fast", "gemini");
    } catch (err) {
      expect(err).toBeInstanceOf(AIRequestError);
      expect((err as AIRequestError).code).toBe("UNSUPPORTED_SERVICE_TIER");
      expect((err as AIRequestError).message).toContain("gemini");
    }
  });

  it("extracts applied serviceTier metadata from provider strings", () => {
    expect(serviceTierMetadata("fast")).toEqual({ serviceTier: "fast" });
    expect(serviceTierMetadata("priority")).toEqual({ serviceTier: "priority" });
    expect(serviceTierMetadata("")).toBeUndefined();
    expect(serviceTierMetadata(undefined)).toBeUndefined();
    expect(serviceTierMetadata(1)).toBeUndefined();
  });
});
