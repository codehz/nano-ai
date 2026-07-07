/**
 * ChatCompletionsAdapter 测试
 *
 * 使用 mock fetch 注入 chat.completions SSE 数据。
 */

import { describe, it, expect } from "bun:test";
import { ChatCompletionsAdapter, collectStream } from "../src/index.js";

import type { NormalizedRequest, FetchFn } from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────

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

describe("ChatCompletionsAdapter - text streaming", () => {
  it("should produce message events from delta chunks", async () => {
    const chunks = [
      'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-123","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n',
      "data: [DONE]\n",
    ];

    const adapter = new ChatCompletionsAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("Hello world");
    expect(result.output).toHaveLength(1);
    expect(result.output[0]!.type).toBe("message");
    expect(result.stopReason).toBe("end_turn");
  });

  it("should handle streaming without explicit role chunk", async () => {
    const chunks = [
      'data: {"id":"chatcmpl-124","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-124","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-124","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n',
      "data: [DONE]\n",
    ];

    const adapter = new ChatCompletionsAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("Hi there");
  });

  it("should handle finish_reason length", async () => {
    const chunks = [
      'data: {"id":"chatcmpl-125","choices":[{"index":0,"delta":{"content":"Long text"},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-125","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n',
      "data: [DONE]\n",
    ];

    const adapter = new ChatCompletionsAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.stopReason).toBe("max_output_tokens");
    expect(result.text).toBe("Long text");
  });
});

// ── 工具调用流 ────────────────────────────────────────────────

describe("ChatCompletionsAdapter - tool calls", () => {
  it("should produce tool_call events from delta (tool_calls format)", async () => {
    const chunks = [
      'data: {"id":"chatcmpl-tc1","choices":[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-tc1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-tc1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-tc1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Hangzhou\\"}"}}]},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-tc1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n',
      "data: [DONE]\n",
    ];

    const adapter = new ChatCompletionsAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("get_weather");
    expect(result.toolCalls[0]!.argumentsText).toBe('{"city":"Hangzhou"}');
    expect(result.stopReason).toBe("tool_call");
  });

  it("should handle legacy function_call format", async () => {
    const chunks = [
      'data: {"id":"chatcmpl-fc1","choices":[{"index":0,"delta":{"role":"assistant","content":null,"function_call":{"name":"search","arguments":""}},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-fc1","choices":[{"index":0,"delta":{"function_call":{"arguments":"{\\"q\\":"}},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-fc1","choices":[{"index":0,"delta":{"function_call":{"arguments":"\\"hello\\"}"}},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-fc1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n',
      "data: [DONE]\n",
    ];

    const adapter = new ChatCompletionsAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("search");
    expect(result.toolCalls[0]!.argumentsText).toBe('{"q":"hello"}');
  });

  it("should include usage when present in final chunk", async () => {
    const chunks = [
      'data: {"id":"chatcmpl-u1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-u1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n',
      "data: [DONE]\n",
    ];

    const adapter = new ChatCompletionsAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(2);
    expect(result.usage?.totalTokens).toBe(12);
  });

  it("should produce message + tool calls in same response", async () => {
    const chunks = [
      'data: {"id":"chatcmpl-mt1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-mt1","choices":[{"index":0,"delta":{"content":"I\'ll check"},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-mt1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":"{}"}}]},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-mt1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n',
      "data: [DONE]\n",
    ];

    const adapter = new ChatCompletionsAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.output).toHaveLength(2);
    expect(result.output[0]!.type).toBe("message");
    expect(result.output[1]!.type).toBe("tool_call");
    expect(result.text).toBe("I'll check");
  });
});

// ── 请求构建 ──────────────────────────────────────────────────

describe("ChatCompletionsAdapter - request building", () => {
  function captureRequest(): { captured: { current: object | null }; fetch: FetchFn } {
    const captured: { current: object | null } = { current: null };
    return {
      captured,
      fetch: async (_url: string, init: RequestInit) => {
        captured.current = JSON.parse(init.body as string);
        const done = [
          'data: {"id":"chatcmpl-r","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n',
          "data: [DONE]\n",
        ];
        return sseResponse(...done);
      },
    };
  }

  it("should convert instructions to system message", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ChatCompletionsAdapter({ apiKey: "test-key", fetch });

    await collectStream(adapter.stream(makeRequest({ instructions: "Be concise." })));
    const body = captured.current as Record<string, unknown> | null;
    const messages = body?.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toBe("Be concise.");
  });

  it("should map tool_call to assistant tool_calls", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ChatCompletionsAdapter({ apiKey: "test-key", fetch });

    await collectStream(
      adapter.stream(
        makeRequest({
          input: [
            { type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "weather?" }] },
            { type: "tool_call" as const, id: "tc1", name: "get_weather", argumentsText: "{}" },
          ],
        }),
      ),
    );
    const body = captured.current as Record<string, unknown> | null;
    const messages = body?.messages as Array<Record<string, unknown>>;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.tool_calls).toHaveLength(1);
  });

  it("should map tool_result to tool role", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ChatCompletionsAdapter({ apiKey: "test-key", fetch });

    await collectStream(
      adapter.stream(
        makeRequest({
          input: [
            {
              type: "tool_result" as const,
              callId: "tc1",
              toolName: "get_weather",
              outcome: "success" as const,
              content: [{ type: "text" as const, text: "sunny" }],
            },
          ],
        }),
      ),
    );
    const body = captured.current as Record<string, unknown> | null;
    const messages = body?.messages as Array<Record<string, unknown>>;
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool_call_id).toBe("tc1");
  });

  it("should include tool_choice when provided", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ChatCompletionsAdapter({ apiKey: "test-key", fetch });

    await collectStream(
      adapter.stream(
        makeRequest({
          tools: [{ name: "get_weather", inputSchema: {} }],
          toolChoice: { type: "tool" as const, name: "get_weather" },
        }),
      ),
    );
    const body = captured.current as Record<string, unknown> | null;
    expect(body?.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
  });

  it("should include temperature and max_tokens", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ChatCompletionsAdapter({ apiKey: "test-key", fetch });

    await collectStream(adapter.stream(makeRequest({ temperature: 0.3, maxOutputTokens: 200 })));
    const body = captured.current as Record<string, unknown> | null;
    expect(body?.temperature).toBe(0.3);
    expect(body?.max_tokens).toBe(200);
  });
});

// ── 错误处理 ──────────────────────────────────────────────────

describe("ChatCompletionsAdapter - error handling", () => {
  it("should emit warning on HTTP error", async () => {
    const errorResponse = new Response("Unauthorized", { status: 401 });
    const adapter = new ChatCompletionsAdapter({
      apiKey: "bad-key",
      fetch: async () => errorResponse,
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain("Chat Completions API error 401");
    expect(result.output).toEqual([]);
  });

  it("should handle incomplete stream gracefully", async () => {
    const chunks = [
      'data: {"id":"chatcmpl-inc","choices":[{"index":0,"delta":{"role":"assistant","content":"Partial"},"finish_reason":null}]}\n',
      // 没有 finish_reason 就断流
    ];

    const adapter = new ChatCompletionsAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    // 应该拿到 warning + partial output
    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes("INCOMPLETE_STREAM") || w.includes("finish_reason"))).toBe(true);
    expect(result.text).toBe("Partial");
  });
});

// ── 集成测试 ──────────────────────────────────────────────────

describe("ChatCompletionsAdapter - integration", () => {
  it("should produce events consumable via for-await-of", async () => {
    const chunks = [
      'data: {"id":"chatcmpl-int","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":"stop"}]}\n',
      "data: [DONE]\n",
    ];

    const adapter = new ChatCompletionsAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
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

  it("should produce complete AIResponse with all fields", async () => {
    const chunks = [
      'data: {"id":"chatcmpl-final","choices":[{"index":0,"delta":{"role":"assistant","content":"Done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n',
      "data: [DONE]\n",
    ];

    const adapter = new ChatCompletionsAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(
      adapter.stream(
        makeRequest({
          requestId: "chat-integration",
        }),
      ),
    );

    expect(result.text).toBe("Done");
    expect(result.output).toHaveLength(1);
    expect(result.output[0]!.type).toBe("message");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage?.inputTokens).toBe(5);
    expect(result.usage?.outputTokens).toBe(1);
    expect(result.stopReason).toBe("end_turn");
    expect(result.backend.adapter).toBe("chat-completions");
    expect(result.backend.requestId).toBe("chat-integration");
    expect(result.replay).toBeDefined();
    expect(result.replay!.length).toBeGreaterThanOrEqual(1);
  });
});
