import { describe, it, expect } from "bun:test";

import { createEventFactory, aggregateEvents, collectStream, textBlock } from "../src/index.js";

import type { AIStreamEvent } from "../src/index.js";

// ── Shared helpers ───────────────────────────────────────────

function makeFactory() {
  return createEventFactory({
    responseId: "resp-123",
    backend: { kind: "responses", isSynthetic: false },
  });
}

/** 将事件数组包装为 AsyncIterable */
async function* iter(events: AIStreamEvent[]): AsyncIterable<AIStreamEvent> {
  for (const e of events) {
    yield e;
  }
}

// ── EventFactory ──────────────────────────────────────────────

describe("EventFactory", () => {
  it("should produce incrementing sequence numbers", () => {
    const f = makeFactory();
    const e1 = f.responseStarted("gpt-4");
    const e2 = f.messageStarted("m1");
    const e3 = f.messageDelta("m1", textBlock("hi"));

    expect(e1.sequence).toBe(0);
    expect(e2.sequence).toBe(1);
    expect(e3.sequence).toBe(2);
    expect(f.sequence).toBe(3);
  });

  it("should carry responseId and backend into events", () => {
    const e = makeFactory().responseStarted("gpt-4");
    expect(e.responseId).toBe("resp-123");
    expect(e.backend).toEqual({ kind: "responses", isSynthetic: false });
  });

  it("should produce valid timestamps", () => {
    const e = makeFactory().responseStarted("gpt-4");
    expect(e.timestamp).toBeString();
    expect(new Date(e.timestamp).getTime()).not.toBeNaN();
  });

  it("should produce all event types", () => {
    const f = makeFactory();

    expect(f.responseStarted("gpt-4").type).toBe("response.started");
    expect(f.responseWarning("warning msg", "WARN").type).toBe("response.warning");
    expect(f.responseWarning("only message").code).toBeUndefined();
    expect(f.responseAuxiliary({ usage: { totalTokens: 10 } }).type).toBe("response.auxiliary");
    expect(f.responseCompleted({ replay: [] }).type).toBe("response.completed");

    expect(f.messageStarted("m1").type).toBe("message.started");
    expect(f.messageDelta("m1", textBlock("hi")).type).toBe("message.delta");
    expect(f.messageCompleted("m1").type).toBe("message.completed");

    expect(f.reasoningStarted("r1", "full").type).toBe("reasoning.started");
    expect(f.reasoningDelta("r1", textBlock("thinking...")).type).toBe("reasoning.delta");
    expect(f.reasoningCompleted("r1").type).toBe("reasoning.completed");

    expect(f.toolCallStarted("tc1", "get_weather").type).toBe("tool_call.started");
    expect(f.toolCallDelta("tc1", { argumentsText: "{}" }).type).toBe("tool_call.delta");
    expect(f.toolCallCompleted("tc1").type).toBe("tool_call.completed");
  });

  it("should accept synthetic backend", () => {
    const synth = createEventFactory({
      responseId: "synth-1",
      backend: { kind: "chat-completions", isSynthetic: true },
    });
    const e = synth.responseStarted("claude-3");
    expect(e.backend.isSynthetic).toBe(true);
    expect(e.backend.kind).toBe("chat-completions");
  });
});

// ── aggregateEvents ───────────────────────────────────────────

describe("aggregateEvents", () => {
  it("should produce a basic text response from message events", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.messageStarted("m1"),
      f.messageDelta("m1", textBlock("Hello")),
      f.messageDelta("m1", textBlock(" world")),
      f.messageCompleted("m1"),
      f.responseCompleted({ replay: [] }),
    ];

    const result = aggregateEvents(events);
    expect(result.text).toBe("Hello world");
    expect(result.output).toHaveLength(1);
    expect(result.output[0]!.type).toBe("message");
  });

  it("should aggregate reasoning events", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.reasoningStarted("r1", "full"),
      f.reasoningDelta("r1", textBlock("Thinking step 1...")),
      f.reasoningCompleted("r1"),
      f.responseCompleted({ replay: [] }),
    ];

    const result = aggregateEvents(events);
    expect(result.output).toHaveLength(1);
    expect(result.output[0]!.type).toBe("reasoning");
    if (result.output[0]!.type === "reasoning") {
      expect(result.output[0]!.visibility).toBe("full");
    }
  });

  it("should aggregate tool_calls", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.toolCallStarted("tc1", "get_weather"),
      f.toolCallDelta("tc1", { argumentsText: '{"city":' }),
      f.toolCallDelta("tc1", { argumentsText: '"Hangzhou"}' }),
      f.toolCallCompleted("tc1"),
      f.responseCompleted({ replay: [] }),
    ];

    const result = aggregateEvents(events);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("get_weather");
    expect(result.toolCalls[0]!.argumentsText).toBe('{"city":"Hangzhou"}');
  });

  it("should merge multiple response.auxiliary patches", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.responseAuxiliary({
        usage: { inputTokens: 10 },
        auxiliary: { providerMetadata: { requestId: "req-123" } },
      }),
      f.responseAuxiliary({
        usage: { outputTokens: 20 },
        auxiliary: { providerMetadata: { serviceTier: "default" } },
      }),
      f.responseCompleted({
        replay: [],
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    ];

    const result = aggregateEvents(events);
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(20);
    expect(result.auxiliary?.providerMetadata).toEqual({
      requestId: "req-123",
      serviceTier: "default",
    });
  });

  it("should collect warnings from response.warning events", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.responseWarning("usage missing", "USAGE_MISSING"),
      f.responseWarning("replay degraded"),
      f.responseCompleted({ replay: [], warnings: ["usage missing", "replay degraded"] }),
    ];

    const result = aggregateEvents(events);
    expect(result.warnings).toEqual(["usage missing", "replay degraded"]);
  });

  it("should preserve auxiliary and warnings from response.completed", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.responseAuxiliary({
        auxiliary: {
          providerMetadata: { requestId: "req-123" },
        },
      }),
      f.responseCompleted({
        replay: [],
        auxiliary: {
          usageSource: "stream",
          providerUsage: { input_tokens: 10, output_tokens: 5 },
          providerMetadata: { serviceTier: "default" },
        },
        warnings: ["synthetic warning"],
      }),
    ];

    const result = aggregateEvents(events);
    expect(result.auxiliary?.usageSource).toBe("stream");
    expect(result.auxiliary?.providerUsage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(result.auxiliary?.providerMetadata).toEqual({
      requestId: "req-123",
      serviceTier: "default",
    });
    expect(result.warnings).toEqual(["synthetic warning"]);
  });

  it("should produce correct text from multi-message output", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.messageStarted("m1"),
      f.messageDelta("m1", { type: "text", text: "First. " }),
      f.messageCompleted("m1"),
      f.messageStarted("m2"),
      f.messageDelta("m2", { type: "text", text: "Second." }),
      f.messageCompleted("m2"),
      f.responseCompleted({ replay: [] }),
    ];

    const result = aggregateEvents(events);
    expect(result.text).toBe("First. Second.");
  });

  it("should interleave reasoning, message, and tool_call in output order", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      // reasoning first
      f.reasoningStarted("r1", "full"),
      f.reasoningDelta("r1", { type: "text", text: "think..." }),
      f.reasoningCompleted("r1"),
      // then message
      f.messageStarted("m1"),
      f.messageDelta("m1", { type: "text", text: "Answer." }),
      f.messageCompleted("m1"),
      // then tool_call
      f.toolCallStarted("tc1", "search"),
      f.toolCallCompleted("tc1"),
      f.responseCompleted({ replay: [] }),
    ];

    const result = aggregateEvents(events);
    expect(result.output).toHaveLength(3);
    expect(result.output[0]!.type).toBe("reasoning");
    expect(result.output[1]!.type).toBe("message");
    expect(result.output[2]!.type).toBe("tool_call");
    expect(result.text).toBe("Answer.");
  });

  it("should preserve item start order when completion order differs", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.reasoningStarted("r1", "full"),
      f.reasoningDelta("r1", textBlock("think")),
      f.messageStarted("m1"),
      f.messageDelta("m1", textBlock("answer")),
      f.messageCompleted("m1"),
      f.reasoningCompleted("r1"),
      f.responseCompleted({ replay: [] }),
    ];

    const result = aggregateEvents(events);
    expect(result.output.map((item) => item.type)).toEqual(["reasoning", "message"]);
  });

  it("should preserve stopReason from response.completed", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.messageStarted("m1"),
      f.messageDelta("m1", { type: "text", text: "ok" }),
      f.messageCompleted("m1"),
      f.responseCompleted({ replay: [], stopReason: "end_turn" }),
    ];

    const result = aggregateEvents(events);
    expect(result.stopReason).toBe("end_turn");
  });

  it("should take replay from response.completed", () => {
    const f = makeFactory();
    const replay = [
      { type: "message" as const, role: "assistant" as const, content: [{ type: "text" as const, text: "prev" }] },
    ];
    const events: AIStreamEvent[] = [f.responseStarted("gpt-4"), f.responseCompleted({ replay })];

    const result = aggregateEvents(events);
    expect(result.replay).toEqual(replay);
  });

  it("should use usage from auxiliary and response.completed (response wins)", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.responseAuxiliary({ usage: { inputTokens: 10, outputTokens: 5 } }),
      f.responseCompleted({ replay: [], usage: { inputTokens: 10, outputTokens: 5 } }),
    ];
    const result = aggregateEvents(events);
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it("should throw if stream ends without response.completed", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.messageStarted("m1"),
      f.messageDelta("m1", { type: "text", text: "hi" }),
    ];

    expect(() => aggregateEvents(events)).toThrow();
  });

  it("should reject a stream without response.started", () => {
    const f = makeFactory();
    expect(() => aggregateEvents([f.responseCompleted({ replay: [] })])).toThrow("response.started");
  });

  it("should reject duplicate response.started events", () => {
    const f = makeFactory();
    expect(() => aggregateEvents([f.responseStarted("gpt-4"), f.responseStarted("gpt-4")])).toThrow(
      "exactly one response.started",
    );
  });

  it("should reject non-contiguous event sequences", () => {
    const f = makeFactory();
    const started = f.responseStarted("gpt-4");
    const completed = f.responseCompleted({ replay: [] });
    completed.sequence += 1;

    expect(() => aggregateEvents([started, completed])).toThrow("Expected event sequence");
  });

  it("should reject inconsistent response IDs", () => {
    const f = makeFactory();
    const started = f.responseStarted("gpt-4");
    const completed = f.responseCompleted({ replay: [] });
    completed.responseId = "different-response";

    expect(() => aggregateEvents([started, completed])).toThrow("same responseId");
  });

  it("should reject events after response.completed", () => {
    const f = makeFactory();
    const events = [f.responseStarted("gpt-4"), f.responseCompleted({ replay: [] }), f.responseWarning("too late")];

    expect(() => aggregateEvents(events)).toThrow("final stream event");
  });

  it("should handle empty output", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [f.responseStarted("gpt-4"), f.responseCompleted({ replay: [] })];

    const result = aggregateEvents(events);
    expect(result.output).toHaveLength(0);
    expect(result.text).toBe("");
  });

  it("should not include warnings when none are emitted", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [f.responseStarted("gpt-4"), f.responseCompleted({ replay: [] })];

    const result = aggregateEvents(events);
    expect(result.warnings).toBeUndefined();
  });
});

// ── 状态机负面测试 ─────────────────────────────────────────

describe("aggregateEvents - state machine negative tests", () => {
  it("should reject delta for item that was never started", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.messageDelta("ghost", { type: "text", text: "no started before me" }),
    ];
    expect(() => aggregateEvents(events)).toThrow("unknown item");
  });

  it("should reject completed for item that was never started", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [f.responseStarted("gpt-4"), f.messageCompleted("ghost")];
    expect(() => aggregateEvents(events)).toThrow("unknown item");
  });

  it("should reject duplicate item id", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [f.responseStarted("gpt-4"), f.messageStarted("m1"), f.messageStarted("m1")];
    expect(() => aggregateEvents(events)).toThrow("already active");
  });

  it("should reject type mismatch: message delta on started reasoning item", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.reasoningStarted("r1", "full"),
      f.messageDelta("r1", { type: "text", text: "wrong type" }),
    ];
    expect(() => aggregateEvents(events)).toThrow("reasoning");
  });

  it("should reject response.completed when there are active items", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.messageStarted("m1"),
      f.messageDelta("m1", { type: "text", text: "never completed" }),
      f.responseCompleted({ replay: [] }),
    ];
    expect(() => aggregateEvents(events)).toThrow("active items");
  });
});

// ── collectStream ─────────────────────────────────────────────

describe("collectStream", () => {
  it("should collect and aggregate events from an async iterable", async () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.messageStarted("m1"),
      f.messageDelta("m1", { type: "text", text: "Hello" }),
      f.messageCompleted("m1"),
      f.responseCompleted({ replay: [] }),
    ];

    const result = await collectStream(iter(events));
    expect(result.text).toBe("Hello");
  });

  it("should reject when there is no response.completed", async () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [f.responseStarted("gpt-4")];

    await expect(collectStream(iter(events))).rejects.toThrow();
  });
});
