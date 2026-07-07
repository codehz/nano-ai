import { describe, it, expect } from "bun:test";

import { createEventFactory, aggregateEvents, collectStream } from "../src/index.js";

import type { AIStreamEvent, AIResponse, MessageItem, ReasoningItem, ToolCallItem } from "../src/index.js";

// ── Shared helpers ───────────────────────────────────────────

function makeFactory() {
  return createEventFactory({
    responseId: "resp-123",
    backend: { kind: "responses", isSynthetic: false },
  });
}

/** 为测试快速构造一个包含 response.completed 的 AIResponse */
function makeCompletedResponse(overrides?: Partial<AIResponse>): AIResponse {
  return {
    id: "resp-123",
    output: [],
    replay: [],
    text: "",
    toolCalls: [],
    backend: { adapter: "responses", isSyntheticStream: false },
    ...overrides,
  };
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
    const e3 = f.messageDelta("m1", "hi");

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
    const resp = makeCompletedResponse();

    expect(f.responseStarted("gpt-4").type).toBe("response.started");
    expect(f.responseWarning("warning msg", "WARN").type).toBe("response.warning");
    expect(f.responseWarning("only message").code).toBeUndefined();
    expect(f.responseAuxiliary({ usage: { totalTokens: 10 } }).type).toBe("response.auxiliary");
    expect(f.responseCompleted(resp).type).toBe("response.completed");

    expect(f.messageStarted("m1").type).toBe("message.started");
    expect(f.messageDelta("m1", "hi").type).toBe("message.delta");
    const msgItem: MessageItem = { type: "message", role: "assistant", content: [{ type: "text", text: "hi" }] };
    expect(f.messageCompleted(msgItem).type).toBe("message.completed");

    expect(f.reasoningStarted("r1", "full").type).toBe("reasoning.started");
    expect(f.reasoningDelta("r1", { type: "text", text: "thinking..." }).type).toBe("reasoning.delta");
    const reasonItem: ReasoningItem = {
      type: "reasoning",
      visibility: "full",
      content: [{ type: "text", text: "..." }],
    };
    expect(f.reasoningCompleted(reasonItem).type).toBe("reasoning.completed");

    expect(f.toolCallStarted("tc1", "get_weather").type).toBe("tool_call.started");
    expect(f.toolCallDelta("tc1", { argumentsText: "{}" }).type).toBe("tool_call.delta");
    const tcItem: ToolCallItem = { type: "tool_call", id: "tc1", name: "get_weather", argumentsText: "{}" };
    expect(f.toolCallCompleted(tcItem).type).toBe("tool_call.completed");
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
      f.messageDelta("m1", "Hello"),
      f.messageDelta("m1", " world"),
      f.messageCompleted({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      }),
      f.responseCompleted(
        makeCompletedResponse({
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "Hello world" }],
            },
          ],
          text: "Hello world",
        }),
      ),
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
      f.reasoningDelta("r1", { type: "text", text: "Thinking step 1..." }),
      f.reasoningCompleted({
        type: "reasoning",
        visibility: "full",
        content: [{ type: "text", text: "Thinking step 1..." }],
      }),
      f.responseCompleted(
        makeCompletedResponse({
          output: [
            {
              type: "reasoning",
              visibility: "full",
              content: [{ type: "text", text: "Thinking step 1..." }],
            },
          ],
        }),
      ),
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
      f.toolCallCompleted({
        type: "tool_call",
        id: "tc1",
        name: "get_weather",
        argumentsText: '{"city":"Hangzhou"}',
      }),
      f.responseCompleted(
        makeCompletedResponse({
          output: [
            {
              type: "tool_call",
              id: "tc1",
              name: "get_weather",
              argumentsText: '{"city":"Hangzhou"}',
            },
          ],
          toolCalls: [
            {
              type: "tool_call",
              id: "tc1",
              name: "get_weather",
              argumentsText: '{"city":"Hangzhou"}',
            },
          ],
        }),
      ),
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
      f.responseCompleted(
        makeCompletedResponse({
          usage: { inputTokens: 10, outputTokens: 20 },
        }),
      ),
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
      f.responseCompleted(
        makeCompletedResponse({
          warnings: ["usage missing", "replay degraded"],
        }),
      ),
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
      f.responseCompleted(
        makeCompletedResponse({
          auxiliary: {
            usageSource: "stream",
            providerUsage: { input_tokens: 10, output_tokens: 5 },
            providerMetadata: { serviceTier: "default" },
          },
          warnings: ["synthetic warning"],
        }),
      ),
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
      f.messageDelta("m1", "First. "),
      f.messageCompleted({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "First. " }],
      }),
      f.messageStarted("m2"),
      f.messageDelta("m2", "Second."),
      f.messageCompleted({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Second." }],
      }),
      f.responseCompleted(
        makeCompletedResponse({
          output: [
            { type: "message", role: "assistant", content: [{ type: "text", text: "First. " }] },
            { type: "message", role: "assistant", content: [{ type: "text", text: "Second." }] },
          ],
          text: "First. Second.",
        }),
      ),
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
      f.reasoningCompleted({
        type: "reasoning",
        visibility: "full",
        content: [{ type: "text", text: "think..." }],
      }),
      // then message
      f.messageStarted("m1"),
      f.messageDelta("m1", "Answer."),
      f.messageCompleted({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Answer." }],
      }),
      // then tool_call
      f.toolCallStarted("tc1", "search"),
      f.toolCallCompleted({
        type: "tool_call",
        id: "tc1",
        name: "search",
        argumentsText: "{}",
      }),
      f.responseCompleted(
        makeCompletedResponse({
          output: [
            { type: "reasoning", visibility: "full", content: [{ type: "text", text: "think..." }] },
            { type: "message", role: "assistant", content: [{ type: "text", text: "Answer." }] },
            { type: "tool_call", id: "tc1", name: "search", argumentsText: "{}" },
          ],
          text: "Answer.",
          toolCalls: [{ type: "tool_call", id: "tc1", name: "search", argumentsText: "{}" }],
        }),
      ),
    ];

    const result = aggregateEvents(events);
    expect(result.output).toHaveLength(3);
    expect(result.output[0]!.type).toBe("reasoning");
    expect(result.output[1]!.type).toBe("message");
    expect(result.output[2]!.type).toBe("tool_call");
    expect(result.text).toBe("Answer.");
  });

  it("should preserve stopReason from response.completed", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.messageStarted("m1"),
      f.messageDelta("m1", "ok"),
      f.messageCompleted({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      }),
      f.responseCompleted(
        makeCompletedResponse({
          stopReason: "end_turn",
          output: [{ type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] }],
          text: "ok",
        }),
      ),
    ];

    const result = aggregateEvents(events);
    expect(result.stopReason).toBe("end_turn");
  });

  it("should take replay from response.completed", () => {
    const f = makeFactory();
    const replay = [
      { type: "message" as const, role: "assistant" as const, content: [{ type: "text" as const, text: "prev" }] },
    ];
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.responseCompleted(makeCompletedResponse({ replay })),
    ];

    const result = aggregateEvents(events);
    expect(result.replay).toEqual(replay);
  });

  it("should use usage from auxiliary and response.completed (response wins)", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.responseAuxiliary({ usage: { inputTokens: 10, outputTokens: 5 } }),
      f.responseCompleted(
        makeCompletedResponse({
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      ),
    ];
    const result = aggregateEvents(events);
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it("should throw if stream ends without response.completed", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [f.responseStarted("gpt-4"), f.messageStarted("m1"), f.messageDelta("m1", "hi")];

    expect(() => aggregateEvents(events)).toThrow();
  });

  it("should handle empty output", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.responseCompleted(makeCompletedResponse({ output: [], text: "" })),
    ];

    const result = aggregateEvents(events);
    expect(result.output).toHaveLength(0);
    expect(result.text).toBe("");
  });

  it("should not include warnings when none are emitted", () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [f.responseStarted("gpt-4"), f.responseCompleted(makeCompletedResponse())];

    const result = aggregateEvents(events);
    expect(result.warnings).toBeUndefined();
  });
});

// ── collectStream ─────────────────────────────────────────────

describe("collectStream", () => {
  it("should collect and aggregate events from an async iterable", async () => {
    const f = makeFactory();
    const events: AIStreamEvent[] = [
      f.responseStarted("gpt-4"),
      f.messageStarted("m1"),
      f.messageDelta("m1", "Hello"),
      f.messageCompleted({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      }),
      f.responseCompleted(
        makeCompletedResponse({
          output: [{ type: "message", role: "assistant", content: [{ type: "text", text: "Hello" }] }],
          text: "Hello",
        }),
      ),
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
