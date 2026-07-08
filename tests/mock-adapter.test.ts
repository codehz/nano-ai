import { describe, expect, it } from "bun:test";

import { AIRequestError, MockAdapter, collectStream, createAIClient, jsonBlock, textBlock } from "../src/index.js";

describe("MockAdapter", () => {
  it("should script a tool-calling turn and expose turn metadata", async () => {
    const adapter = new MockAdapter({
      turns: [
        {
          name: "plan",
          expect: {
            items: [{ type: "message", role: "user", textIncludes: "天气" }],
            tools: "present",
            toolChoice: "present",
          },
          steps: [
            { type: "message", content: "我先调用天气工具。" },
            {
              type: "tool_call",
              id: "call-weather-1",
              name: "get_weather",
              argumentsText: '{"city":"Hangzhou"}',
              argumentsJson: { city: "Hangzhou" },
            },
          ],
        },
      ],
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
    expect(result.auxiliary?.providerMetadata?.turnName).toBe("plan");
  });

  it("should validate replay and tool_result across a manual tool loop", async () => {
    const client = createAIClient({
      adapter: new MockAdapter({
        turns: [
          {
            name: "request-tool",
            expect: {
              ordered: true,
              items: [{ type: "message", role: "user", textIncludes: "weather" }],
              tools: "present",
              toolChoice: "present",
            },
            steps: [
              { type: "message", content: "Checking live weather now." },
              {
                type: "tool_call",
                id: "call-weather-2",
                name: "get_weather",
                argumentsText: '{"city":"Hangzhou"}',
              },
            ],
          },
          {
            name: "consume-tool-result",
            expect: {
              requireReplayFromPreviousTurn: true,
              requireToolResultsForPendingCalls: true,
              ordered: true,
              items: [
                { type: "message", role: "assistant", textIncludes: "Checking live weather now." },
                { type: "tool_call", name: "get_weather" },
                { type: "tool_result", callId: "call-weather-2", toolName: "get_weather", outcome: "success" },
              ],
            },
            steps: [{ type: "message", content: "Hangzhou is 28C and sunny." }],
          },
        ],
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
      turns: [
        {
          steps: [
            {
              type: "tool_call",
              id: "call-order-1",
              name: "create_order",
              argumentsText: '{"sku":"SKU-1"}',
            },
          ],
        },
        {
          expect: {
            requireToolResultsForPendingCalls: true,
          },
          steps: [{ type: "message", content: "This should never run." }],
        },
      ],
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
      turns: [
        {
          steps: [
            { type: "warning", message: "content filtered by policy", code: "CONTENT_FILTERED" },
            {
              type: "complete",
              stopReason: "content_filter",
              providerMetadata: { moderationCategory: "violence" },
            },
          ],
        },
      ],
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
      turns: [
        {
          steps: [
            { type: "message", content: "partial answer" },
            { type: "interrupt" },
          ],
        },
      ],
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
      turns: [
        {
          steps: [
            { type: "message", content: "upstream failed after planning" },
            { type: "error", message: "mock upstream timeout", code: "UPSTREAM_TIMEOUT" },
          ],
        },
      ],
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
});
