import { describe, it, expect } from "bun:test";
import { createAIClient, normalizeRequest, validateRequest, assertValidRequest, AIRequestError } from "../src/index.js";

import type { AIRequest, NormalizedRequest, AIStreamEvent, BackendAdapter, ContentBlock } from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────

function createMockAdapter(kind: BackendAdapter["kind"] = "responses"): BackendAdapter {
  return {
    kind,
    capabilities: {
      nativeStreaming: true,
      messageStreaming: true,
      reasoningStreaming: true,
      toolCallStreaming: true,
      hiddenReasoningReplay: "full",
      replayFidelity: "high",
      tools: true,
      usage: "full",
      billing: "lookup",
      providerMetadata: true,
    },
    stream(_request: NormalizedRequest): AsyncIterable<AIStreamEvent> {
      return (async function* () {})();
    },
  };
}

function validRequest(overrides?: Partial<AIRequest>): AIRequest {
  return {
    input: [{ type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
    ...overrides,
  };
}

// ── AIRequestError ────────────────────────────────────────────

describe("AIRequestError", () => {
  it("should have the correct name", () => {
    const err = new AIRequestError("bad request", "INVALID");
    expect(err.name).toBe("AIRequestError");
    expect(err.code).toBe("INVALID");
    expect(err.message).toBe("bad request");
  });
});

// ── validateRequest ───────────────────────────────────────────

describe("validateRequest", () => {
  it("should return empty for a valid request", () => {
    const issues = validateRequest(validRequest());
    expect(issues).toBeArray();
    expect(issues).toHaveLength(0);
  });

  it("should detect empty input", () => {
    const issues = validateRequest(validRequest({ input: [] }));
    expect(issues.some((i) => i.code === "INPUT_EMPTY")).toBe(true);
  });

  it("should detect missing input", () => {
    const issues = validateRequest(validRequest({ input: undefined as unknown as [] }));
    expect(issues.some((i) => i.code === "INPUT_EMPTY")).toBe(true);
  });

  it("should detect invalid input items", () => {
    const issues = validateRequest(validRequest({ input: [null as unknown as never] }));
    expect(issues.some((i) => i.code === "INPUT_INVALID_ITEM")).toBe(true);
  });

  it("should detect message items without content array", () => {
    const issues = validateRequest(
      validRequest({
        input: [{ type: "message", role: "user" } as unknown as AIRequest["input"][number]],
      }),
    );
    expect(issues.some((i) => i.code === "MESSAGE_CONTENT_INVALID")).toBe(true);
  });

  it("should detect unknown input item types", () => {
    const issues = validateRequest(
      validRequest({
        input: [{ type: "mystery" } as unknown as AIRequest["input"][number]],
      }),
    );
    expect(issues.some((i) => i.code === "INPUT_ITEM_UNKNOWN_TYPE")).toBe(true);
  });

  it("should detect invalid content blocks", () => {
    const issues = validateRequest(
      validRequest({
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "image" } as unknown as ContentBlock],
          },
        ],
      }),
    );
    expect(issues.some((i) => i.code === "CONTENT_BLOCK_INVALID")).toBe(true);
  });

  it("should detect invalid instructions type", () => {
    const issues = validateRequest(validRequest({ instructions: 123 as unknown as AIRequest["instructions"] }));
    expect(issues.some((i) => i.code === "INSTRUCTIONS_INVALID")).toBe(true);
  });

  it("should detect non-array input", () => {
    const issues = validateRequest({ ...validRequest(), input: "bad" as unknown as AIRequest["input"] });
    expect(issues.some((i) => i.code === "INPUT_EMPTY")).toBe(true);
  });

  it("should detect invalid include object", () => {
    const issues = validateRequest(validRequest({ include: "bad" as unknown as AIRequest["include"] }));
    expect(issues.some((i) => i.code === "INCLUDE_INVALID")).toBe(true);
  });

  it("should detect invalid metadata object", () => {
    const issues = validateRequest(validRequest({ metadata: "bad" as unknown as AIRequest["metadata"] }));
    expect(issues.some((i) => i.code === "METADATA_INVALID")).toBe(true);
  });

  it("should detect temperature out of range (negative)", () => {
    const issues = validateRequest(validRequest({ temperature: -1 }));
    expect(issues.some((i) => i.code === "TEMPERATURE_OUT_OF_RANGE")).toBe(true);
  });

  it("should detect temperature out of range (>2)", () => {
    const issues = validateRequest(validRequest({ temperature: 2.5 }));
    expect(issues.some((i) => i.code === "TEMPERATURE_OUT_OF_RANGE")).toBe(true);
  });

  it("should accept temperature at boundaries", () => {
    expect(validateRequest(validRequest({ temperature: 0 }))).toHaveLength(0);
    expect(validateRequest(validRequest({ temperature: 2 }))).toHaveLength(0);
  });

  it("should detect NaN temperature", () => {
    const issues = validateRequest(validRequest({ temperature: NaN }));
    expect(issues.some((i) => i.code === "TEMPERATURE_NOT_NUMBER")).toBe(true);
  });

  it("should detect non-integer maxOutputTokens", () => {
    const issues = validateRequest(validRequest({ maxOutputTokens: 1.5 }));
    expect(issues.some((i) => i.code === "MAX_OUTPUT_TOKENS_INVALID")).toBe(true);
  });

  it("should detect zero maxOutputTokens", () => {
    const issues = validateRequest(validRequest({ maxOutputTokens: 0 }));
    expect(issues.some((i) => i.code === "MAX_OUTPUT_TOKENS_INVALID")).toBe(true);
  });

  it("should detect negative maxOutputTokens", () => {
    const issues = validateRequest(validRequest({ maxOutputTokens: -5 }));
    expect(issues.some((i) => i.code === "MAX_OUTPUT_TOKENS_INVALID")).toBe(true);
  });

  it("should accept valid maxOutputTokens", () => {
    expect(validateRequest(validRequest({ maxOutputTokens: 100 }))).toHaveLength(0);
  });

  it("should detect duplicate tool names", () => {
    const issues = validateRequest(
      validRequest({
        tools: [
          { name: "weather", inputSchema: {} },
          { name: "weather", inputSchema: {} },
        ],
      }),
    );
    expect(issues.some((i) => i.code === "TOOLS_DUPLICATE_NAME")).toBe(true);
  });

  it("should detect invalid tool schema", () => {
    const issues = validateRequest(
      validRequest({
        tools: [{ name: "weather", inputSchema: null as unknown as Record<string, unknown> }],
      }),
    );
    expect(issues.some((i) => i.code === "TOOL_INPUT_SCHEMA_INVALID")).toBe(true);
  });

  it("should detect toolChoice references unknown tool", () => {
    const issues = validateRequest(
      validRequest({
        tools: [{ name: "tool_a", inputSchema: {} }],
        toolChoice: { type: "tool", name: "tool_b" },
      }),
    );
    expect(issues.some((i) => i.code === "TOOL_CHOICE_UNKNOWN_TOOL")).toBe(true);
  });

  it("should detect toolChoice but no tools defined", () => {
    const issues = validateRequest(
      validRequest({
        toolChoice: { type: "tool", name: "any" },
      }),
    );
    expect(issues.some((i) => i.code === "TOOL_CHOICE_NO_TOOLS")).toBe(true);
  });

  it("should accept matching toolChoice", () => {
    expect(
      validateRequest(
        validRequest({
          tools: [{ name: "weather", inputSchema: {} }],
          toolChoice: { type: "tool", name: "weather" },
        }),
      ),
    ).toHaveLength(0);
  });

  it("should accept auto/none toolChoice without tools", () => {
    expect(validateRequest(validRequest({ toolChoice: "auto" }))).toHaveLength(0);
    expect(validateRequest(validRequest({ toolChoice: "none" }))).toHaveLength(0);
  });
});

// ── assertValidRequest ────────────────────────────────────────

describe("assertValidRequest", () => {
  it("should not throw for valid request", () => {
    expect(() => assertValidRequest(validRequest())).not.toThrow();
  });

  it("should throw AIRequestError for invalid request", () => {
    expect(() => assertValidRequest(validRequest({ input: [] }))).toThrow(AIRequestError);
  });
});

// ── normalizeRequest ──────────────────────────────────────────

describe("normalizeRequest", () => {
  it("should return a NormalizedRequest with model and requestId", () => {
    const result = normalizeRequest(validRequest(), { model: "gpt-4" });
    expect(result.model).toBe("gpt-4");
    expect(result.requestId).toBeString();
    expect(result.requestId).not.toBeEmpty();
  });

  it("should preserve request fields", () => {
    const result = normalizeRequest(validRequest({ temperature: 0.7, maxOutputTokens: 500 }), { model: "gpt-4" });
    expect(result.temperature).toBe(0.7);
    expect(result.maxOutputTokens).toBe(500);
  });

  it("should merge defaults with request fields (request wins)", () => {
    const result = normalizeRequest(validRequest({ temperature: 0.5 }), {
      model: "gpt-4",
      defaults: { temperature: 1.0, maxOutputTokens: 100 },
    });
    // request.temperature wins
    expect(result.temperature).toBe(0.5);
    // defaults.maxOutputTokens fills in
    expect(result.maxOutputTokens).toBe(100);
  });

  it("should fill include defaults when not provided", () => {
    const result = normalizeRequest(validRequest(), { model: "gpt-4" });
    expect(result.include).toEqual({
      usage: "best_effort",
      billing: "best_effort",
      providerMetadata: "best_effort",
    });
  });

  it("should merge include with request include winning", () => {
    const result = normalizeRequest(validRequest({ include: { usage: "off" } }), {
      model: "gpt-4",
      defaults: { include: { billing: "off" } },
    });
    expect(result.include).toEqual({
      usage: "off",
      billing: "off",
      providerMetadata: "best_effort",
    });
  });

  it("should override input from defaults with request input", () => {
    const defaultInput = validRequest().input;
    const customInput: AIRequest["input"] = [
      { type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "custom" }] },
    ];
    const result = normalizeRequest(validRequest({ input: customInput }), {
      model: "gpt-4",
      defaults: { input: defaultInput },
    });
    expect(result.input).toBe(customInput);
  });

  it("should throw on invalid request after normalization", () => {
    expect(() => normalizeRequest({ input: [] }, { model: "gpt-4" })).toThrow(AIRequestError);
  });
});

// ── createAIClient ────────────────────────────────────────────

describe("createAIClient", () => {
  it("should return an AIClient", () => {
    const client = createAIClient({ adapter: createMockAdapter(), model: "gpt-4" });
    expect(client).toHaveProperty("stream");
    expect(typeof client.stream).toBe("function");
  });

  it("should produce an async iterable from stream()", async () => {
    const client = createAIClient({ adapter: createMockAdapter(), model: "gpt-4" });
    const stream = client.stream(validRequest());
    const events: AIStreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    // mock adapter yields nothing
    expect(events).toHaveLength(0);
  });

  it("should delegate to adapter with a normalized request", async () => {
    let captured: NormalizedRequest | undefined;
    const adapter: BackendAdapter = {
      ...createMockAdapter(),
      stream(request: NormalizedRequest): AsyncIterable<AIStreamEvent> {
        captured = request;
        return (async function* () {})();
      },
    };
    const client = createAIClient({ adapter, model: "gpt-4" });
    const req = validRequest({ temperature: 0.3 });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of client.stream(req)) {
      // consume
    }
    expect(captured).toBeDefined();
    expect(captured!.model).toBe("gpt-4");
    expect(captured!.temperature).toBe(0.3);
    expect(captured!.requestId).toBeString();
  });

  it("should apply defaults when client has defaults", async () => {
    let captured: NormalizedRequest | undefined;
    const adapter: BackendAdapter = {
      ...createMockAdapter(),
      stream(request: NormalizedRequest): AsyncIterable<AIStreamEvent> {
        captured = request;
        return (async function* () {})();
      },
    };
    const client = createAIClient({
      adapter,
      model: "gpt-4",
      defaults: { maxOutputTokens: 200 },
    });
    for await (const _ of client.stream(validRequest())) {
      // consume
    }
    expect(captured!.maxOutputTokens).toBe(200);
  });

  it("should reject invalid request via stream()", () => {
    const client = createAIClient({ adapter: createMockAdapter(), model: "gpt-4" });
    expect(() => {
      client.stream({ input: [] });
    }).toThrow(AIRequestError);
  });
});
