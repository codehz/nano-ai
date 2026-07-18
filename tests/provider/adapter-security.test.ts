import { describe, expect, it } from "bun:test";
import {
  extractProviderErrorMessage,
  measureJsonDepth,
  providerHttpError,
  validateOpaqueReplayEnvelope,
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
    expect(measureJsonDepth({})).toBe(1);
    expect(measureJsonDepth({ a: 1 })).toBe(1);
    expect(measureJsonDepth({ a: { b: 1 } })).toBe(2);
    expect(measureJsonDepth([{ a: [{ b: 1 }] }])).toBe(4);
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

  it("rejects oversized payloads", () => {
    const big = { blob: "x".repeat(MAX_OPAQUE_PAYLOAD_BYTES) };
    const result = validateOpaqueReplayEnvelope(big);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("exceeds max size");
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
    expect(extractProviderErrorMessage(JSON.stringify({ error: { message: "Rate limit exceeded" } }), 429)).toBe(
      "Rate limit exceeded",
    );
  });

  it("extracts string error field", () => {
    expect(extractProviderErrorMessage(JSON.stringify({ error: "invalid_api_key" }), 401)).toBe("invalid_api_key");
  });

  it("extracts top-level message", () => {
    expect(extractProviderErrorMessage(JSON.stringify({ message: "boom" }), 500)).toBe("boom");
  });

  it("omits HTML bodies", () => {
    const html = "<!DOCTYPE html><html><body>Internal Server Error with path /secret</body></html>";
    expect(extractProviderErrorMessage(html, 502)).toBe(`HTTP 502. Body omitted (${html.length} bytes)`);
  });

  it("returns HTTP status for empty body", () => {
    expect(extractProviderErrorMessage("", 500)).toBe("HTTP 500");
  });

  it("omits long non-JSON bodies", () => {
    const body = "x".repeat(250);
    expect(extractProviderErrorMessage(body, 503)).toBe(`HTTP 503. Body omitted (${body.length} bytes)`);
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
