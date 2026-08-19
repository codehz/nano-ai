import { describe, expect, it } from "bun:test";
import {
  extractProviderErrorMessage,
  providerHttpError,
  validateOpaqueReplayEnvelope,
} from "../../src/provider/security.js";
import { AIProviderError } from "../../src/runtime/errors.js";

describe("validateOpaqueReplayEnvelope", () => {
  it("rejects non-objects", () => {
    expect(validateOpaqueReplayEnvelope(null).ok).toBe(false);
    expect(validateOpaqueReplayEnvelope("x").ok).toBe(false);
  });

  it("accepts small plain objects", () => {
    expect(validateOpaqueReplayEnvelope({ role: "assistant", content: "hi" }).ok).toBe(true);
  });

  it("accepts large and deeply nested JSON payloads", () => {
    let deep: unknown = { blob: "x".repeat(2_000_000) };
    for (let i = 0; i < 32; i++) deep = { nested: deep };
    expect(validateOpaqueReplayEnvelope(deep, { maxBytes: 1 }).ok).toBe(true);
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
