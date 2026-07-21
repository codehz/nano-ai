/**
 * Opaque replay 薄层：accept + rollback-by-role
 */

import { describe, expect, it } from "bun:test";

import { acceptOpaqueReplay } from "../../src/provider/opaque-replay.js";
import { NormalizedRequestMapper } from "../../src/provider/request-mapper.js";
import { AIRequestError } from "../../src/runtime/errors.js";
import { MAX_OPAQUE_PAYLOAD_BYTES } from "../../src/provider/security.js";

describe("acceptOpaqueReplay", () => {
  it("returns null for wrong source without throwing", () => {
    expect(
      acceptOpaqueReplay(
        { source: "messages", purpose: "replay", payload: { role: "assistant", content: "x" } },
        "chat.completions",
      ),
    ).toBeNull();
  });

  it("returns null for non-replay purpose without throwing", () => {
    expect(
      acceptOpaqueReplay(
        {
          source: "chat.completions",
          purpose: "provider_state",
          payload: { role: "assistant", content: "x" },
        },
        "chat.completions",
      ),
    ).toBeNull();
  });

  it("returns payload object for matching source and purpose", () => {
    const payload = { role: "assistant", content: "hi" };
    expect(acceptOpaqueReplay({ source: "ollama", purpose: "replay", payload }, "ollama")).toEqual(payload);
  });

  it("throws AIRequestError for invalid envelope", () => {
    expect(() =>
      acceptOpaqueReplay(
        {
          source: "gemini",
          purpose: "replay",
          payload: { blob: "x".repeat(MAX_OPAQUE_PAYLOAD_BYTES) },
        },
        "gemini",
      ),
    ).toThrow(AIRequestError);

    try {
      acceptOpaqueReplay(
        {
          source: "gemini",
          purpose: "replay",
          payload: { blob: "x".repeat(MAX_OPAQUE_PAYLOAD_BYTES) },
        },
        "gemini",
      );
    } catch (error) {
      expect(error).toMatchObject({ name: "AIRequestError", code: "INVALID_OPAQUE_REPLAY" });
    }
  });
});

describe("rollbackTrailingAssistantMessages by role", () => {
  const mapper = new NormalizedRequestMapper("test");

  it("pops trailing assistant messages by default", () => {
    const messages = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
    ];
    mapper.rollbackTrailingAssistantMessages(messages);
    expect(messages).toEqual([{ role: "user", content: "q" }]);
  });

  it("pops trailing model messages when role is model", () => {
    const contents = [
      { role: "user", parts: [{ text: "q" }] },
      { role: "model", parts: [{ text: "a1" }] },
      { role: "model", parts: [{ text: "a2" }] },
    ];
    mapper.rollbackTrailingAssistantMessages(contents, "model");
    expect(contents).toEqual([{ role: "user", parts: [{ text: "q" }] }]);
  });
});
