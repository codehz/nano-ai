/**
 * mapStopReason / mapReasoningVisibility — 大块 A 权威入口
 */

import { describe, expect, it } from "bun:test";

import { mapReasoningVisibility, mapStopReason } from "../../src/index.js";

describe("mapStopReason", () => {
  it("should map OpenAI / chat finish reasons", () => {
    expect(mapStopReason("stop")).toBe("end_turn");
    expect(mapStopReason("length")).toBe("max_output_tokens");
    expect(mapStopReason("content_filter")).toBe("content_filter");
    expect(mapStopReason("tool_calls")).toBe("tool_call");
  });

  it("should map Anthropic stop reasons", () => {
    expect(mapStopReason("end_turn")).toBe("end_turn");
    expect(mapStopReason("max_tokens")).toBe("max_output_tokens");
    expect(mapStopReason("tool_use")).toBe("tool_call");
  });

  it("should map Gemini finishReason values", () => {
    expect(mapStopReason("STOP")).toBe("end_turn");
    expect(mapStopReason("MAX_TOKENS")).toBe("max_output_tokens");
    expect(mapStopReason("SAFETY")).toBe("content_filter");
    expect(mapStopReason("RECITATION")).toBe("content_filter");
    expect(mapStopReason("BLOCKLIST")).toBe("content_filter");
    expect(mapStopReason("PROHIBITED_CONTENT")).toBe("content_filter");
    expect(mapStopReason("SPII")).toBe("content_filter");
    expect(mapStopReason("MALFORMED_FUNCTION_CALL")).toBe("error");
    expect(mapStopReason("UNEXPECTED_TOOL_CALL")).toBe("error");
    expect(mapStopReason("TOO_MANY_TOOL_CALLS")).toBe("error");
    expect(mapStopReason("MISSING_THOUGHT_SIGNATURE")).toBe("error");
  });

  it("should map generic error and fallback to unknown", () => {
    expect(mapStopReason("error")).toBe("error");
    expect(mapStopReason("some_random_reason")).toBe("unknown");
  });
});

describe("mapReasoningVisibility", () => {
  it("should prefer redacted when redacted flag is set", () => {
    expect(mapReasoningVisibility(true, true)).toBe("redacted");
    expect(mapReasoningVisibility(false, true)).toBe("redacted");
  });

  it("should map thinking content to full", () => {
    expect(mapReasoningVisibility(true, false)).toBe("full");
  });

  it("should map no thinking content to opaque", () => {
    expect(mapReasoningVisibility(false, false)).toBe("opaque");
  });
});
