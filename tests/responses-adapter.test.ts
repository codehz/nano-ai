/**
 * ResponsesAdapter 测试
 *
 * 使用 mock fetch 注入 SSE 数据，不需要真实 API key。
 */

import { describe, it, expect } from "bun:test";
import { AIProviderError, AIRequestError, ResponsesAdapter, collectStream } from "../src/index.js";

import type { NormalizedRequest, FetchFn } from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────

/**
 * 构造一个 SSE 流的 Response 对象。
 */
function sseResponse(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function mockFetch(resp: Response): FetchFn {
  return async () => resp;
}

function makeRequest(overrides?: Partial<NormalizedRequest>): NormalizedRequest {
  return {
    model: "gpt-4o",
    requestId: "test-req-1",
    input: [{ type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }],
    ...overrides,
  };
}

// ── 文本流 ────────────────────────────────────────────────────

describe("ResponsesAdapter - text streaming", () => {
  it("should produce message events from a simple text SSE stream", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.delta\ndata: {"item_id":"m1","delta":"Hello"}\n\n',
      'event: response.output_text.delta\ndata: {"item_id":"m1","delta":" world"}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"Hello world"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          id: "resp-123",
          model: "gpt-4o",
          output: [{ id: "m1", type: "message", content: [{ type: "text", text: "Hello world" }] }],
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("Hello world");
    expect(result.output).toHaveLength(1);
    expect(result.output[0]!.type).toBe("message");
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(3);
    expect(result.backend.rawResponseId).toBe("resp-123");
  });

  it("should map input/output token details in completed usage", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"Hi"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          id: "resp-usage-details",
          model: "gpt-4o",
          output: [{ id: "m1", type: "message" }],
          usage: {
            input_tokens: 50,
            output_tokens: 20,
            total_tokens: 70,
            input_tokens_details: { cached_tokens: 5 },
            output_tokens_details: { reasoning_tokens: 8 },
          },
        },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.usage?.cachedInputTokens).toBe(5);
    expect(result.usage?.reasoningTokens).toBe(8);
  });

  it("should handle streaming multiple messages", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.delta\ndata: {"item_id":"m1","delta":"First"}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"First"}\n\n',
      'event: response.output_item.added\ndata: {"item":{"id":"m2","type":"message"}}\n\n',
      'event: response.output_text.delta\ndata: {"item_id":"m2","delta":"Second"}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m2","text":"Second"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: { id: "resp-2", model: "gpt-4o", output: [] },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("FirstSecond");
    expect(result.output).toHaveLength(2);
  });

  it("should produce reasoning events", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"r1","type":"reasoning"}}\n\n',
      'event: response.reasoning.delta\ndata: {"item_id":"r1","delta":"Thinking..."}\n\n',
      'event: response.reasoning.done\ndata: {"item_id":"r1","text":"Thinking..."}\n\n',
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.delta\ndata: {"item_id":"m1","delta":"Answer"}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"Answer"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: { id: "resp-r", model: "gpt-4o", output: [] },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.output).toHaveLength(2);
    expect(result.output[0]!.type).toBe("reasoning");
    expect(result.output[1]!.type).toBe("message");
    expect(result.text).toBe("Answer");
  });

  it("should produce tool_call events", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"tc1","type":"function_call","name":"get_weather"}}\n\n',
      'event: response.tool_call.delta\ndata: {"item_id":"tc1","delta":{"arguments":"{\\"city\\":\\"Hangzhou\\"}"}}\n\n',
      'event: response.tool_call.done\ndata: {"item_id":"tc1","name":"get_weather","arguments":"{\\"city\\":\\"Hangzhou\\"}"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          id: "resp-tc",
          model: "gpt-4o",
          output: [{ id: "tc1", type: "function_call", name: "get_weather" }],
        },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("get_weather");
    expect(result.toolCalls[0]!.argumentsText).toBe('{"city":"Hangzhou"}');
  });

  it("should infer stop_reason as tool_call when function_call present", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"tc1","type":"function_call","name":"search"}}\n\n',
      'event: response.tool_call.done\ndata: {"item_id":"tc1","name":"search","arguments":"{}"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: { id: "resp-tc2", model: "gpt-4o", output: [{ id: "tc1", type: "function_call", name: "search" }] },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.stopReason).toBe("tool_call");
  });

  it("should include replay with opaque continuation", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.delta\ndata: {"item_id":"m1","delta":"Hi"}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"Hi"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: { id: "resp-replay", model: "gpt-4o", output: [] },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.replay).toHaveLength(2); // message replay + opaque continuation
    expect(result.replay[0]!.type).toBe("message");
    expect(result.replay[1]!.type).toBe("opaque");
    if (result.replay[1]!.type === "opaque") {
      expect(result.replay[1]!.source).toBe("responses");
      expect(result.replay[1]!.purpose).toBe("replay");
    }
  });

  it("should parse final SSE event without trailing blank line", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"Hi"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: { id: "resp-no-blank", model: "gpt-4o", output: [{ id: "m1", type: "message" }] },
      })}`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("Hi");
    expect(result.backend.rawResponseId).toBe("resp-no-blank");
  });

  it("should emit completed only once when response.completed repeats", async () => {
    const completed = `event: response.completed\ndata: ${JSON.stringify({
      response: { id: "resp-dup", model: "gpt-4o", output: [{ id: "m1", type: "message" }] },
    })}\n\n`;
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"Hi"}\n\n',
      completed,
      completed,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const eventTypes: string[] = [];
    for await (const event of adapter.stream(makeRequest())) {
      eventTypes.push(event.type);
    }

    expect(eventTypes.filter((type) => type === "response.completed")).toHaveLength(1);
  });
});

// ── Request building ──────────────────────────────────────────

describe("ResponsesAdapter - request building", () => {
  function captureRequest(): { captured: { current: object | null }; fetch: FetchFn } {
    const captured: { current: object | null } = { current: null };
    return {
      captured,
      fetch: async (_url: string, init: RequestInit) => {
        captured.current = JSON.parse(init.body as string);
        return sseResponse(
          `event: response.completed\ndata: ${JSON.stringify({ response: { id: "r", model: "gpt-4o", output: [] } })}\n\n`,
        );
      },
    };
  }

  it("should include model and input in request body", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(adapter.stream(makeRequest({ model: "gpt-4o" })));
    const body = captured.current as Record<string, unknown> | null;
    expect(body?.model).toBe("gpt-4o");
    expect(body?.stream).toBe(true);
    expect(body?.input).toBeDefined();
  });

  it("should include instructions when provided", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(adapter.stream(makeRequest({ instructions: "Be helpful." })));
    const body = captured.current as Record<string, unknown> | null;
    expect(body?.instructions).toBe("Be helpful.");
  });

  it("should serialize instruction blocks when provided", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(
      adapter.stream(
        makeRequest({
          instructions: [
            { type: "text", text: "Be helpful." },
            { type: "json", json: { format: "json" } },
          ],
        }),
      ),
    );
    const body = captured.current as Record<string, unknown> | null;
    expect(body?.instructions).toBe('Be helpful.\n{"format":"json"}');
  });

  it("should include metadata when provided", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(adapter.stream(makeRequest({ metadata: { traceId: "trace-1" } })));
    const body = captured.current as Record<string, unknown> | null;
    expect(body?.metadata).toEqual({ traceId: "trace-1" });
  });

  it("should include tools in request body", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(
      adapter.stream(
        makeRequest({
          tools: [{ name: "get_weather", description: "Get weather", inputSchema: { type: "object" } }],
        }),
      ),
    );
    const body = captured.current as Record<string, unknown> | null;
    expect(body?.tools).toHaveLength(1);
  });

  it("should include temperature and max_output_tokens", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(adapter.stream(makeRequest({ temperature: 0.5, maxOutputTokens: 100 })));
    const body = captured.current as Record<string, unknown> | null;
    expect(body?.temperature).toBe(0.5);
    expect(body?.max_output_tokens).toBe(100);
  });

  it("should include tool_choice when provided", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(
      adapter.stream(
        makeRequest({
          tools: [{ name: "get_weather", inputSchema: {} }],
          toolChoice: { type: "tool" as const, name: "get_weather" },
        }),
      ),
    );
    const body = captured.current as Record<string, unknown> | null;
    expect(body?.tool_choice).toEqual({ type: "function", name: "get_weather" });
  });

  it("should reject unsupported image content instead of sending empty text", async () => {
    const { fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await expect(
      collectStream(
        adapter.stream(
          makeRequest({
            input: [
              {
                type: "message" as const,
                role: "user" as const,
                content: [{ type: "image" as const, imageUrl: "https://example.com/cat.png" }],
              },
            ],
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(AIRequestError);
  });

  it("should round-trip replay without duplicating canonical items when opaque continuation is present", async () => {
    const round1SSE = [
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.delta\ndata: {"item_id":"m1","delta":"Hi"}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"Hi"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          id: "resp-round-1",
          model: "gpt-4o",
          output: [{ id: "m1", type: "message", content: [{ type: "text", text: "Hi" }] }],
        },
      })}\n\n`,
    ];

    const round1Adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...round1SSE)),
    });

    const round1 = await collectStream(
      round1Adapter.stream(
        makeRequest({
          input: [
            { type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] },
          ],
        }),
      ),
    );

    const { captured, fetch } = captureRequest();
    const round2Adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(
      round2Adapter.stream(
        makeRequest({
          input: [
            { type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] },
            ...round1.replay,
          ],
        }),
      ),
    );

    const body = captured.current as Record<string, unknown> | null;
    expect(body?.input).toEqual([
      { type: "message", role: "user", content: "Hello" },
      { type: "item_reference", id: "resp-round-1" },
    ]);
  });
});

// ── Error handling ────────────────────────────────────────────

describe("ResponsesAdapter - error handling", () => {
  it("should throw on HTTP error", async () => {
    const errorResponse = new Response("Unauthorized", {
      status: 401,
      statusText: "Unauthorized",
    });

    const adapter = new ResponsesAdapter({
      apiKey: "bad-key",
      fetch: async () => errorResponse,
    });

    await expect(collectStream(adapter.stream(makeRequest()))).rejects.toBeInstanceOf(AIProviderError);
  });

  it("should emit warning on SSE error event", async () => {
    const sse = [
      'event: error\ndata: {"message":"Rate limit exceeded","code":"RATE_LIMITED"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: { id: "r", model: "gpt-4o", output: [] },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toContain("Rate limit exceeded");
  });

  it("should omit usage when include.usage is off", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"Hi"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          id: "resp-usage-off",
          model: "gpt-4o",
          output: [{ id: "m1", type: "message" }],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest({ include: { usage: "off" } })));
    expect(result.usage).toBeUndefined();
  });

  it("should omit billing warning when include.billing is off", async () => {
    const sse = [
      `event: response.completed\ndata: ${JSON.stringify({
        response: { id: "resp-billing-off", model: "gpt-4o", output: [] },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest({ include: { billing: "off" } })));
    expect(result.warnings?.some((w) => w.includes("Billing information"))).toBeFalsy();
  });

  it("should emit warning for malformed SSE data", async () => {
    const sse = [
      "event: response.output_item.added\ndata: {bad json}\n\n",
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"Hi"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: { id: "resp-malformed", model: "gpt-4o", output: [] },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest({ include: { billing: "off" } })));
    expect(result.warnings?.some((w) => w.includes("malformed Responses SSE"))).toBe(true);
    expect(result.text).toBe("Hi");
  });
});

// ── Integration with collectStream and aggregator ─────────────

describe("ResponsesAdapter - integration", () => {
  it("should produce events consumable via for-await-of", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.delta\ndata: {"item_id":"m1","delta":"Hi"}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"Hi"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: { id: "r", model: "gpt-4o", output: [] },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const eventTypes: string[] = [];
    for await (const event of adapter.stream(makeRequest())) {
      eventTypes.push(event.type);
    }

    expect(eventTypes[0]).toBe("response.started");
    expect(eventTypes).toContain("message.started");
    expect(eventTypes).toContain("message.delta");
    expect(eventTypes).toContain("message.completed");
    expect(eventTypes[eventTypes.length - 1]).toBe("response.completed");
  });

  it("should produce a complete stream with all response fields populated", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.delta\ndata: {"item_id":"m1","delta":"Done"}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"Done"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          id: "resp-final",
          model: "gpt-4o",
          output: [],
          usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
        },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(
      adapter.stream(
        makeRequest({
          requestId: "integration-test-1",
        }),
      ),
    );

    // 验证 AIResponse 的完整结构
    expect(result.id).toBe("integration-test-1");
    expect(result.text).toBe("Done");
    expect(result.output).toHaveLength(1);
    expect(result.toolCalls).toEqual([]);
    expect(result.usage?.inputTokens).toBe(5);
    expect(result.usage?.outputTokens).toBe(1);
    expect(result.backend.adapter).toBe("responses");
    expect(result.backend.requestId).toBe("integration-test-1");
    expect(result.replay).toBeDefined();
  });
});
