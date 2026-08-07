import { describe, expect, it } from "bun:test";
import {
  clampOpaquePayloadLimit,
  extractProviderErrorMessage,
  measureJsonDepth,
  providerHttpError,
  validateOpaqueReplayEnvelope,
  DEFAULT_MAX_OPAQUE_PAYLOAD_BYTES,
  HARD_MAX_OPAQUE_PAYLOAD_BYTES,
  MAX_OPAQUE_JSON_DEPTH,
  MAX_OPAQUE_PAYLOAD_BYTES,
} from "../../src/provider/security.js";
import { AIProviderError } from "../../src/runtime/errors.js";

describe("measureJsonDepth", () => {
  it("returns 0 for primitives", () => {
    expect(measureJsonDepth(null)).toBe(0);
    expect(measureJsonDepth("x")).toBe(0);
    expect(measureJsonDepth(1)).toBe(0);
  });

  it("counts object and array nesting", () => {
    expect(measureJsonDepth({ a: 1 })).toBe(1);
    expect(measureJsonDepth({ a: { b: 1 } })).toBe(2);
    expect(measureJsonDepth([{ a: 1 }])).toBe(2);
  });
});

describe("clampOpaquePayloadLimit", () => {
  it("defaults and clamps to hard ceiling", () => {
    expect(clampOpaquePayloadLimit()).toBe(DEFAULT_MAX_OPAQUE_PAYLOAD_BYTES);
    expect(clampOpaquePayloadLimit(Number.NaN)).toBe(DEFAULT_MAX_OPAQUE_PAYLOAD_BYTES);
    expect(clampOpaquePayloadLimit(0)).toBe(DEFAULT_MAX_OPAQUE_PAYLOAD_BYTES);
    expect(clampOpaquePayloadLimit(-1)).toBe(DEFAULT_MAX_OPAQUE_PAYLOAD_BYTES);
    expect(clampOpaquePayloadLimit(1024)).toBe(1024);
    expect(clampOpaquePayloadLimit(HARD_MAX_OPAQUE_PAYLOAD_BYTES + 1)).toBe(HARD_MAX_OPAQUE_PAYLOAD_BYTES);
  });
});

describe("validateOpaqueReplayEnvelope", () => {
  it("rejects non-objects", () => {
    expect(validateOpaqueReplayEnvelope(null).ok).toBe(false);
    expect(validateOpaqueReplayEnvelope("x").ok).toBe(false);
  });

  it("accepts small plain objects", () => {
    expect(validateOpaqueReplayEnvelope({ role: "assistant", content: "hi" }).ok).toBe(true);
  });

  it("accepts payloads larger than the legacy 64KiB under the default 1MiB limit", () => {
    const mid = { blob: "x".repeat(70_000) };
    expect(validateOpaqueReplayEnvelope(mid).ok).toBe(true);
  });

  it("rejects oversized payloads at the default limit", () => {
    const big = { blob: "x".repeat(MAX_OPAQUE_PAYLOAD_BYTES) };
    const result = validateOpaqueReplayEnvelope(big);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("exceeds max size");
    }
  });

  it("honors a tighter custom maxBytes", () => {
    const payload = { blob: "x".repeat(2000) };
    expect(validateOpaqueReplayEnvelope(payload, { maxBytes: 500 }).ok).toBe(false);
    expect(validateOpaqueReplayEnvelope(payload, { maxBytes: 10_000 }).ok).toBe(true);
  });

  it("cannot exceed the hard ceiling even if maxBytes is larger", () => {
    const huge = { blob: "x".repeat(HARD_MAX_OPAQUE_PAYLOAD_BYTES) };
    const result = validateOpaqueReplayEnvelope(huge, {
      maxBytes: HARD_MAX_OPAQUE_PAYLOAD_BYTES * 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(`> ${HARD_MAX_OPAQUE_PAYLOAD_BYTES}`);
    }
  });

  it("rejects deep nesting", () => {
    let deep: unknown = { v: 1 };
    for (let i = 0; i < MAX_OPAQUE_JSON_DEPTH + 2; i++) {
      deep = { nested: deep };
    }
    const result = validateOpaqueReplayEnvelope(deep);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("nesting depth");
    }
  });
});

describe("extractProviderErrorMessage", () => {
  it("extracts nested JSON error.message", () => {
    expect(extractProviderErrorMessage(JSON.stringify({ error: { message: "nope" } }), 400)).toBe("nope");
  });

  it("extracts string error field", () => {
    expect(extractProviderErrorMessage(JSON.stringify({ error: "invalid_api_key" }), 401)).toBe("invalid_api_key");
  });

  it("extracts top-level message", () => {
    expect(extractProviderErrorMessage(JSON.stringify({ message: "boom" }), 500)).toBe("boom");
  });

  it("omits HTML bodies", () => {
    expect(extractProviderErrorMessage("<!DOCTYPE html><html></html>", 502)).toContain("Body omitted");
  });

  it("returns HTTP status for empty body", () => {
    expect(extractProviderErrorMessage("", 500)).toBe("HTTP 500");
  });

  it("omits long non-JSON bodies", () => {
    expect(extractProviderErrorMessage("x".repeat(500), 500)).toContain("Body omitted");
  });

  it("keeps short plain-text bodies", () => {
    expect(extractProviderErrorMessage("Unauthorized", 401)).toBe("Unauthorized");
  });
});

describe("providerHttpError", () => {
  it("builds AIProviderError with sanitized body", () => {
    const html = "<!DOCTYPE html>" + "z".repeat(300);
    const err = providerHttpError(502, html);
    expect(err).toBeInstanceOf(AIProviderError);
    expect(err.statusCode).toBe(502);
    expect(err.responseBody).toBe(`HTTP 502. Body omitted (${html.length} bytes)`);
    expect(err.message).toContain("Provider returned 502");
    expect(err.responseBody).not.toContain("<!DOCTYPE");
  });
});
