/**
 * OllamaAdapter 测试
 *
 * 使用 mock fetch 注入 Ollama NDJSON 流数据。
 */

import { describe, it, expect } from "bun:test";
import { AIRequestError, OllamaAdapter, collectStream } from "../src/index.js";

import type { NormalizedRequest, FetchFn } from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────

function ndjsonResponse(...chunks: string[]): Response {
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
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

function mockFetch(resp: Response): FetchFn {
  return async () => resp;
}

function makeRequest(overrides?: Partial<NormalizedRequest>): NormalizedRequest {
  return {
    model: "llama3.2",
    requestId: "test-ollama-1",
    input: [{ type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }],
    ...overrides,
  };
}

// ── 文本流 ────────────────────────────────────────────────────

describe("OllamaAdapter - text streaming", () => {
  it("should produce message events from NDJSON chunks", async () => {
    const chunks = [
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"Hello"},"done":false}\n`,
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:01Z","message":{"role":"assistant","content":" world"},"done":false}\n`,
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:02Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":2}\n`,
    ];

    const adapter = new OllamaAdapter({ fetch: mockFetch(ndjsonResponse(...chunks)) });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("Hello world");
    expect(result.output).toHaveLength(1);
    expect(result.output[0]!.type).toBe("message");
    expect(result.stopReason).toBe("end_turn");
  });

  it("should handle single-chunk response", async () => {
    const chunks = [
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"Hi there!"},"done":true,"done_reason":"stop","prompt_eval_count":5,"eval_count":2}\n`,
    ];

    const adapter = new OllamaAdapter({ fetch: mockFetch(ndjsonResponse(...chunks)) });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("Hi there!");
    expect(result.stopReason).toBe("end_turn");
  });

  it("should handle finish_reason length/max_tokens", async () => {
    const chunks = [
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"Long text"},"done":true,"done_reason":"length","prompt_eval_count":5,"eval_count":50}\n`,
    ];

    const adapter = new OllamaAdapter({ fetch: mockFetch(ndjsonResponse(...chunks)) });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.stopReason).toBe("max_output_tokens");
    expect(result.text).toBe("Long text");
  });

  it("should handle empty content response", async () => {
    const chunks = [
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}\n`,
    ];

    const adapter = new OllamaAdapter({ fetch: mockFetch(ndjsonResponse(...chunks)) });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("");
    expect(result.output).toHaveLength(0);
    expect(result.stopReason).toBe("end_turn");
  });

  it("should include usage when available", async () => {
    const chunks = [
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"Hello"},"done":true,"done_reason":"stop","prompt_eval_count":15,"eval_count":5}\n`,
    ];

    const adapter = new OllamaAdapter({ fetch: mockFetch(ndjsonResponse(...chunks)) });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.usage).toBeDefined();
    expect(result.usage!.inputTokens).toBe(15);
    expect(result.usage!.outputTokens).toBe(5);
    expect(result.usage!.totalTokens).toBe(20);
  });

  it("should handle streaming without explicit newlines in single read", async () => {
    const allChunks = [
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"Hi"},"done":false}\n`,
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:01Z","message":{"role":"assistant","content":" there"},"done":false}\n`,
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:02Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}\n`,
    ];

    const adapter = new OllamaAdapter({ fetch: mockFetch(ndjsonResponse(...allChunks)) });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("Hi there");
  });
});

// ── 工具调用 ──────────────────────────────────────────────────

describe("OllamaAdapter - tool calls", () => {
  it("should produce tool_call events from final chunk", async () => {
    const chunks = [
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"get_weather","arguments":{"city":"Hangzhou"}}}]},"done":true,"done_reason":"stop"}\n`,
    ];

    const adapter = new OllamaAdapter({ fetch: mockFetch(ndjsonResponse(...chunks)) });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("get_weather");
    expect(result.toolCalls[0]!.argumentsText).toBe('{"city":"Hangzhou"}');
    expect(result.stopReason).toBe("end_turn");
  });

  it("should handle multiple tool calls", async () => {
    const chunks = [
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"get_weather","arguments":{"city":"Hangzhou"}}},{"function":{"name":"get_time","arguments":{"tz":"UTC"}}}]},"done":true,"done_reason":"stop"}\n`,
    ];

    const adapter = new OllamaAdapter({ fetch: mockFetch(ndjsonResponse(...chunks)) });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]!.name).toBe("get_weather");
    expect(result.toolCalls[1]!.name).toBe("get_time");
  });

  it("should handle tool call with content", async () => {
    const chunks = [
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"Let me check the weather."},"done":false}\n`,
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:01Z","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"get_weather","arguments":{"city":"Hangzhou"}}}]},"done":true,"done_reason":"stop"}\n`,
    ];

    const adapter = new OllamaAdapter({ fetch: mockFetch(ndjsonResponse(...chunks)) });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.output).toHaveLength(2);
    expect(result.output[0]!.type).toBe("message");
    expect(result.output[1]!.type).toBe("tool_call");
    expect(result.text).toBe("Let me check the weather.");
  });
});

// ── 请求构造 ──────────────────────────────────────────────────

describe("OllamaAdapter - request building", () => {
  it("should send instructions as system message", async () => {
    let capturedBody: string | undefined;

    const adapter = new OllamaAdapter({
      fetch: async (_url, init) => {
        capturedBody = init.body as string;
        return ndjsonResponse(
          `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"OK"},"done":true,"done_reason":"stop"}\n`,
        );
      },
    });

    await collectStream(adapter.stream(makeRequest({ instructions: "Be helpful" })));

    expect(capturedBody).toBeDefined();
    const body = JSON.parse(capturedBody!);
    expect(body.messages[0]!.role).toBe("system");
    expect(body.messages[0]!.content).toBe("Be helpful");
  });

  it("should serialize instruction blocks as a system message", async () => {
    let capturedBody: string | undefined;

    const adapter = new OllamaAdapter({
      fetch: async (_url, init) => {
        capturedBody = init.body as string;
        return ndjsonResponse(
          `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"OK"},"done":true,"done_reason":"stop"}\n`,
        );
      },
    });

    await collectStream(
      adapter.stream(
        makeRequest({
          instructions: [
            { type: "text", text: "Be helpful" },
            { type: "json", json: { format: "json" } },
          ],
        }),
      ),
    );

    const body = JSON.parse(capturedBody!);
    expect(body.messages[0]!.content).toBe('Be helpful\n{"format":"json"}');
  });

  it("should include tools in request", async () => {
    let capturedBody: string | undefined;

    const adapter = new OllamaAdapter({
      fetch: async (_url, init) => {
        capturedBody = init.body as string;
        return ndjsonResponse(
          `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"OK"},"done":true,"done_reason":"stop"}\n`,
        );
      },
    });

    await collectStream(
      adapter.stream(
        makeRequest({
          tools: [
            {
              name: "get_weather",
              description: "Get weather",
              inputSchema: {
                type: "object",
                properties: { city: { type: "string" } },
              },
            },
          ],
        }),
      ),
    );

    const body = JSON.parse(capturedBody!);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]!.function.name).toBe("get_weather");
  });

  it("should pass temperature and maxOutputTokens as options", async () => {
    let capturedBody: string | undefined;

    const adapter = new OllamaAdapter({
      fetch: async (_url, init) => {
        capturedBody = init.body as string;
        return ndjsonResponse(
          `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"OK"},"done":true,"done_reason":"stop"}\n`,
        );
      },
    });

    await collectStream(adapter.stream(makeRequest({ temperature: 0.5, maxOutputTokens: 200 })));

    const body = JSON.parse(capturedBody!);
    expect(body.options.temperature).toBe(0.5);
    expect(body.options.num_predict).toBe(200);
  });

  it("should reject explicit toolChoice", async () => {
    const adapter = new OllamaAdapter({
      fetch: async () =>
        ndjsonResponse(
          `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"OK"},"done":true,"done_reason":"stop"}\n`,
        ),
    });

    await expect(
      collectStream(
        adapter.stream(
          makeRequest({
            tools: [{ name: "get_weather", inputSchema: {} }],
            toolChoice: { type: "tool" as const, name: "get_weather" },
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(AIRequestError);
  });

  it("should reject unsupported image content instead of dropping it", async () => {
    const adapter = new OllamaAdapter({
      fetch: async () =>
        ndjsonResponse(
          `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"OK"},"done":true,"done_reason":"stop"}\n`,
        ),
    });

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

  it("should warn when request metadata is provided", async () => {
    const adapter = new OllamaAdapter({
      fetch: async () =>
        ndjsonResponse(
          `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"OK"},"done":true,"done_reason":"stop"}\n`,
        ),
    });

    const result = await collectStream(
      adapter.stream(makeRequest({ metadata: { traceId: "trace-1" }, include: { billing: "off" } })),
    );
    expect(result.warnings?.some((w) => w.includes("Request metadata is not supported"))).toBe(true);
  });

  it("should use custom baseUrl and apiKey", async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;

    const adapter = new OllamaAdapter({
      baseUrl: "http://custom:8080",
      apiKey: "secret-key",
      fetch: async (url, init) => {
        capturedUrl = url;
        capturedAuth = (init.headers as Record<string, string>).Authorization;
        return ndjsonResponse(
          `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"OK"},"done":true,"done_reason":"stop"}\n`,
        );
      },
    });

    await collectStream(adapter.stream(makeRequest()));
    expect(capturedUrl).toBe("http://custom:8080/api/chat");
    expect(capturedAuth).toBe("Bearer secret-key");
  });

  it("should round-trip replay into a single assistant message with tool_calls", async () => {
    const round1Chunks = [
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"I'll check"},"done":false}\n`,
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:01Z","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"search","arguments":{"q":"weather"}}}]},"done":true,"done_reason":"stop"}\n`,
    ];

    const round1Adapter = new OllamaAdapter({ fetch: mockFetch(ndjsonResponse(...round1Chunks)) });
    const round1 = await collectStream(
      round1Adapter.stream(
        makeRequest({
          input: [
            { type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "weather?" }] },
          ],
        }),
      ),
    );

    let capturedBody: string | undefined;
    const round2Adapter = new OllamaAdapter({
      fetch: async (_url, init) => {
        capturedBody = init.body as string;
        return ndjsonResponse(
          `{"model":"llama3.2","created_at":"2024-01-01T00:00:02Z","message":{"role":"assistant","content":"OK"},"done":true,"done_reason":"stop"}\n`,
        );
      },
    });

    await collectStream(
      round2Adapter.stream(
        makeRequest({
          input: [
            { type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "weather?" }] },
            ...round1.replay,
            {
              type: "tool_result" as const,
              callId: round1.toolCalls[0]!.id,
              toolName: round1.toolCalls[0]!.name,
              outcome: "success" as const,
              content: [{ type: "text" as const, text: "sunny" }],
            },
          ],
        }),
      ),
    );

    const body = JSON.parse(capturedBody!);
    expect(body.messages).toEqual([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "I'll check",
        tool_calls: [{ function: { name: "search", arguments: { q: "weather" } } }],
      },
      { role: "tool", content: "sunny" },
    ]);
  });
});

// ── 错误处理 ──────────────────────────────────────────────────

describe("OllamaAdapter - error handling", () => {
  it("should emit warning on non-ok response", async () => {
    const adapter = new OllamaAdapter({
      fetch: async () => new Response("Not Found", { status: 404 }),
    });

    const events: string[] = [];
    for await (const event of adapter.stream(makeRequest())) {
      events.push(event.type);
    }

    expect(events).toContain("response.warning");
    expect(events).toContain("response.completed");
  });

  it("should handle incomplete stream (no done signal)", async () => {
    const chunks = [
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"Partial"},"done":false}\n`,
    ];

    const adapter = new OllamaAdapter({ fetch: mockFetch(ndjsonResponse(...chunks)) });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("Partial");
    // Incomplete stream should still produce output
    expect(result.output).toHaveLength(1);
  });

  it("should omit usage when include.usage is off", async () => {
    const chunks = [
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"Hello"},"done":true,"done_reason":"stop","prompt_eval_count":15,"eval_count":5}\n`,
    ];

    const adapter = new OllamaAdapter({ fetch: mockFetch(ndjsonResponse(...chunks)) });

    const result = await collectStream(adapter.stream(makeRequest({ include: { usage: "off" } })));
    expect(result.usage).toBeUndefined();
  });

  it("should emit warning for malformed NDJSON data", async () => {
    const chunks = [
      `{"bad":true}\n`,
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"Hi"},"done":true,"done_reason":"stop"}\n`,
    ];

    const adapter = new OllamaAdapter({ fetch: mockFetch(ndjsonResponse(...chunks)) });
    const result = await collectStream(adapter.stream(makeRequest({ include: { billing: "off" } })));
    expect(result.warnings?.some((w) => w.includes("malformed Ollama NDJSON"))).toBe(true);
    expect(result.text).toBe("Hi");
  });
});

// ── 适配器属性 ────────────────────────────────────────────────

describe("OllamaAdapter - properties", () => {
  it("should have correct kind and native streaming marker", () => {
    const adapter = new OllamaAdapter();
    expect(adapter.kind).toBe("ollama");
    expect(adapter.nativeStreaming).toBe(true);
  });
});
