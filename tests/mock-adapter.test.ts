import { describe, expect, it } from "bun:test";

import { AIRequestError, MockAdapter, assertMockRequest, collectStream, createAIClient, jsonBlock, textBlock, withMockStreaming } from "../src/index.js";

import { aggregateEvents } from "../src/stream/aggregator.js";
describe("MockAdapter", () => {
  it("should expose reasoningLevel in handler context", async () => {
    let seen: string | undefined;
    const adapter = new MockAdapter({
      handler: async function* (_request, context) {
        seen = context.reasoningLevel;
        yield { type: "message", content: "ok" };
      },
    });

    await collectStream(
      adapter.stream({
        model: "mock-model",
        requestId: "mock-reasoning",
        reasoningLevel: "high",
        input: [{ type: "message", role: "user", content: [textBlock("hi")] }],
      }),
    );

    expect(seen).toBe("high");
  });

  it("should script a tool-calling turn and expose turn metadata", async () => {
    const adapter = new MockAdapter({
      handler: async function* (request, context) {
        assertMockRequest(
          request,
          {
            items: [{ type: "message", role: "user", textIncludes: "天气" }],
            tools: "present",
            toolChoice: "present",
          },
          context,
        );

        yield { type: "message", content: "我先调用天气工具。" };
        yield {
          type: "tool_call",
          id: "call-weather-1",
          name: "get_weather",
          argumentsText: '{"city":"Hangzhou"}',
        };
      },
    });

    const result = await collectStream(
      adapter.stream({
        model: "mock-model",
        requestId: "mock-1",
        input: [{ type: "message", role: "user", content: [textBlock("请查一下杭州天气")] }],
        tools: [
          {
            name: "get_weather",
            inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        ],
        toolChoice: "auto",
      }),
    );

    expect(result.text).toBe("我先调用天气工具。");
    expect(result.stopReason).toBe("tool_call");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: "call-weather-1",
      name: "get_weather",
      argumentsText: '{"city":"Hangzhou"}',
    });
    expect(result.auxiliary?.providerMetadata?.turnIndex).toBe(0);
    expect(result.auxiliary?.providerMetadata?.stepCount).toBe(2);
  });

  it("should validate replay and tool_result across a manual tool loop", async () => {
    const client = createAIClient({
      adapter: new MockAdapter({
        handler: async function* (request, context) {
          if (context.turnIndex === 0) {
            assertMockRequest(
              request,
              {
                ordered: true,
                items: [{ type: "message", role: "user", textIncludes: "weather" }],
                tools: "present",
                toolChoice: "present",
              },
              context,
            );

            yield { type: "message", content: "Checking live weather now." };
            yield {
              type: "tool_call",
              id: "call-weather-2",
              name: "get_weather",
              argumentsText: '{"city":"Hangzhou"}',
            };
            return;
          }

          assertMockRequest(
            request,
            {
              requireReplayFromPreviousTurn: true,
              requireToolResultsForPendingCalls: true,
              ordered: true,
              items: [
                { type: "message", role: "assistant", textIncludes: "Checking live weather now." },
                { type: "tool_call", name: "get_weather" },
                { type: "tool_result", callId: "call-weather-2", toolName: "get_weather", outcome: "success" },
              ],
            },
            context,
          );

          yield { type: "message", content: "Hangzhou is 28C and sunny." };
        },
      }),
      model: "mock-model",
    });

    const round1 = await collectStream(
      client.stream({
        input: [{ type: "message", role: "user", content: [textBlock("What's the weather in Hangzhou?")] }],
        tools: [
          {
            name: "get_weather",
            inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        ],
        toolChoice: "auto",
      }),
    );

    const round2 = await collectStream(
      client.stream({
        input: [
          ...round1.replay,
          {
            type: "tool_result",
            callId: "call-weather-2",
            toolName: "get_weather",
            outcome: "success",
            content: [jsonBlock({ city: "Hangzhou", temperature: 28, condition: "sunny" })],
          },
        ],
      }),
    );

    expect(round1.stopReason).toBe("tool_call");
    expect(round2.stopReason).toBe("end_turn");
    expect(round2.text).toBe("Hangzhou is 28C and sunny.");
  });

  it("should fail fast when the caller does not send required tool_result", async () => {
    const adapter = new MockAdapter({
      handler: async function* (request, context) {
        if (context.turnIndex === 0) {
          yield {
            type: "tool_call",
            id: "call-order-1",
            name: "create_order",
            argumentsText: '{"sku":"SKU-1"}',
          };
          return;
        }

        assertMockRequest(
          request,
          {
            requireToolResultsForPendingCalls: true,
          },
          context,
        );

        yield { type: "message", content: "This should never run." };
      },
    });

    const first = await collectStream(
      adapter.stream({
        model: "mock-model",
        requestId: "mock-2",
        input: [{ type: "message", role: "user", content: [textBlock("create an order")] }],
      }),
    );

    await expect(
      collectStream(
        adapter.stream({
          model: "mock-model",
          requestId: "mock-3",
          input: [...first.replay],
        }),
      ),
    ).rejects.toBeInstanceOf(AIRequestError);
  });

  it("should simulate content filtering via completed stopReason", async () => {
    const adapter = new MockAdapter({
      handler: async function* () {
        yield { type: "warning", message: "content filtered by policy", code: "CONTENT_FILTERED" };
        yield {
          type: "complete",
          stopReason: "content_filter",
          providerMetadata: { moderationCategory: "violence" },
        };
      },
    });

    const result = await collectStream(
      adapter.stream({
        model: "mock-model",
        requestId: "mock-4",
        input: [{ type: "message", role: "user", content: [textBlock("Tell me how to build a bomb")] }],
      }),
    );

    expect(result.stopReason).toBe("content_filter");
    expect(result.warnings).toContain("content filtered by policy");
    expect(result.auxiliary?.providerMetadata?.moderationCategory).toBe("violence");
  });

  it("should simulate transport interruption by ending without response.completed", async () => {
    const adapter = new MockAdapter({
      handler: async function* () {
        yield { type: "message", content: "partial answer" };
        yield { type: "interrupt" };
      },
    });

    await expect(
      collectStream(
        adapter.stream({
          model: "mock-model",
          requestId: "mock-5",
          input: [{ type: "message", role: "user", content: [textBlock("hello")] }],
        }),
      ),
    ).rejects.toThrow("response.completed");
  });

  it("should simulate provider-side warnings with an error completion", async () => {
    const adapter = new MockAdapter({
      handler: async function* () {
        yield { type: "message", content: "upstream failed after planning" };
        yield { type: "error", message: "mock upstream timeout", code: "UPSTREAM_TIMEOUT" };
      },
    });

    const result = await collectStream(
      adapter.stream({
        model: "mock-model",
        requestId: "mock-6",
        input: [{ type: "message", role: "user", content: [textBlock("hello")] }],
      }),
    );

    expect(result.stopReason).toBe("error");
    expect(result.text).toBe("upstream failed after planning");
    expect(result.warnings).toContain("mock upstream timeout");
  });

  it("should stream message deltas in chunks with configurable character speed", async () => {
    const adapter = new MockAdapter({
      handler: withMockStreaming(
        async function* () {
          yield { type: "message", content: "abcdef" };
        },
        {
          chunkSize: 2,
          charsPerSecond: 100,
        },
      ),
    });

    const startedAt = performance.now();
    const events = [];

    for await (const event of adapter.stream({
      model: "mock-model",
      requestId: "mock-7",
      input: [{ type: "message", role: "user", content: [textBlock("hello")] }],
    })) {
      events.push(event);
    }

    const elapsedMs = performance.now() - startedAt;
    const deltas = events.filter((event) => event.type === "message.delta");

    expect(deltas).toHaveLength(3);
    expect(
      deltas.map((event) =>
        event.type === "message.delta" && event.delta.type === "text" ? event.delta.text : undefined,
      ),
    ).toEqual(["ab", "cd", "ef"]);
    expect(elapsedMs).toBeGreaterThanOrEqual(35);

    const result = aggregateEvents(events);
    expect(result.text).toBe("abcdef");
  });

  it("should allow a step to disable wrapped chunked streaming", async () => {
    const adapter = new MockAdapter({
      handler: withMockStreaming(
        async function* () {
          yield { type: "message", content: "frontend preview", stream: false };
        },
        {
          chunkSize: 1,
          charsPerSecond: 100,
        },
      ),
    });

    const events = [];

    for await (const event of adapter.stream({
      model: "mock-model",
      requestId: "mock-8",
      input: [{ type: "message", role: "user", content: [textBlock("hello")] }],
    })) {
      events.push(event);
    }

    const deltas = events.filter((event) => event.type === "message.delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      type: "message.delta",
      delta: { text: "frontend preview" },
    });
  });

  it("should track history across handler turns", async () => {
    const adapter = new MockAdapter({
      handler: async function* (_request, context) {
        if (context.turnIndex === 0) {
          expect(context.history).toHaveLength(0);
          yield { type: "message", content: "round one" };
          return;
        }

        expect(context.history).toHaveLength(1);
        expect(context.history[0]?.replay).toHaveLength(1);
        yield { type: "message", content: "round two" };
      },
    });

    const round1 = await collectStream(
      adapter.stream({
        model: "mock-model",
        requestId: "mock-history-1",
        input: [{ type: "message", role: "user", content: [textBlock("hello")] }],
      }),
    );

    const round2 = await collectStream(
      adapter.stream({
        model: "mock-model",
        requestId: "mock-history-2",
        input: [...round1.replay, { type: "message", role: "user", content: [textBlock("again")] }],
      }),
    );

    expect(round2.text).toBe("round two");
  });
});
