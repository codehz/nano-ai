/**
 * GeminiAdapter 测试
 *
 * 使用 mock fetch 注入 Gemini streamGenerateContent SSE 数据。
 */

import { describe, it, expect } from "bun:test";
import { AIProviderError, AIRequestError, GeminiAdapter, collectStream } from "../../src/index.js";
import type { NormalizedRequest, FetchFn } from "../../src/index.js";
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

function byteChunksResponse(...chunks: Uint8Array[]): Response {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
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
    model: "gemini-2.5-flash",
    requestId: "test-gemini-1",
    input: [{ type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }],
    ...overrides,
  };
}

function dataLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n`;
}

// ── 文本流 ────────────────────────────────────────────────────

describe("GeminiAdapter - text streaming", () => {
  it("should produce message events from SSE chunks", async () => {
    const chunks = [
      dataLine({
        responseId: "resp-1",
        candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, index: 0 }],
      }),
      dataLine({
        responseId: "resp-1",
        candidates: [
          {
            content: { role: "model", parts: [{ text: " world" }] },
            finishReason: "STOP",
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 2,
          totalTokenCount: 12,
        },
      }),
    ];

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("Hello world");
    expect(result.output).toHaveLength(1);
    expect(result.output[0]!.type).toBe("message");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(2);
    expect(result.usage?.totalTokens).toBe(12);
    expect(result.backend.rawResponseId).toBe("resp-1");
    expect(result.backend.adapter).toBe("gemini");
  });

  it("should preserve UTF-8 characters split across transport chunks", async () => {
    const encoder = new TextEncoder();
    const prefix = encoder.encode(
      'data: {"responseId":"resp-utf","candidates":[{"content":{"role":"model","parts":[{"text":"',
    );
    const text = encoder.encode("你好");
    const suffix = encoder.encode('"}]},"finishReason":"STOP","index":0}]}\n');
    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: async () => byteChunksResponse(prefix, text.slice(0, 1), text.slice(1, 4), text.slice(4), suffix),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("你好");
    expect(result.stopReason).toBe("end_turn");
  });

  it("should map MAX_TOKENS finishReason", async () => {
    const chunks = [
      dataLine({
        responseId: "resp-len",
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Long text" }] },
            finishReason: "MAX_TOKENS",
            index: 0,
          },
        ],
      }),
    ];

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.stopReason).toBe("max_output_tokens");
    expect(result.text).toBe("Long text");
  });

  it("should map SAFETY finishReason to content_filter", async () => {
    const chunks = [
      dataLine({
        responseId: "resp-safe",
        candidates: [
          {
            content: { role: "model", parts: [{ text: "" }] },
            finishReason: "SAFETY",
            index: 0,
          },
        ],
      }),
    ];

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest({ include: { billing: "off" } })));
    expect(result.stopReason).toBe("content_filter");
  });

  it("should handle promptFeedback blockReason", async () => {
    const chunks = [
      dataLine({
        responseId: "resp-block",
        promptFeedback: { blockReason: "SAFETY" },
      }),
    ];

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest({ include: { usage: "off", billing: "off" } })));
    expect(result.stopReason).toBe("content_filter");
    expect(result.warnings?.some((w) => w.includes("blocked the prompt"))).toBe(true);
  });

  it("should map usage cache and thoughts tokens", async () => {
    const chunks = [
      dataLine({
        responseId: "resp-usage",
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Hi" }] },
            finishReason: "STOP",
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 3,
          totalTokenCount: 30,
          cachedContentTokenCount: 8,
          thoughtsTokenCount: 7,
        },
      }),
    ];

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.usage?.cachedInputTokens).toBe(8);
    expect(result.usage?.reasoningTokens).toBe(7);
    expect(result.usage?.totalTokens).toBe(30);
  });
});

// ── 工具调用 ──────────────────────────────────────────────────

describe("GeminiAdapter - tool calls", () => {
  it("should map functionCall parts to tool_call items", async () => {
    const chunks = [
      dataLine({
        responseId: "resp-tool",
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    id: "call-1",
                    name: "get_weather",
                    args: { city: "Hangzhou" },
                  },
                },
              ],
            },
            finishReason: "STOP",
            index: 0,
          },
        ],
      }),
    ];

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(
      adapter.stream(
        makeRequest({
          tools: [
            {
              name: "get_weather",
              description: "Weather",
              inputSchema: { type: "object", properties: { city: { type: "string" } } },
            },
          ],
        }),
      ),
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: "call-1",
      name: "get_weather",
      argumentsText: '{"city":"Hangzhou"}',
    });
    expect(result.stopReason).toBe("tool_call");
  });

  it("should support multiple function calls in one turn", async () => {
    const chunks = [
      dataLine({
        responseId: "resp-multi",
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { functionCall: { id: "c1", name: "a", args: { x: 1 } } },
                { functionCall: { id: "c2", name: "b", args: { y: 2 } } },
              ],
            },
            finishReason: "STOP",
            index: 0,
          },
        ],
      }),
    ];

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("should send tool_result as functionResponse in request body", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: async (_url, init) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return sseResponse(
          dataLine({
            responseId: "resp-tr",
            candidates: [
              {
                content: { role: "model", parts: [{ text: "Done" }] },
                finishReason: "STOP",
                index: 0,
              },
            ],
          }),
        );
      },
    });

    await collectStream(
      adapter.stream(
        makeRequest({
          input: [
            { type: "message", role: "user", content: [{ type: "text", text: "weather?" }] },
            {
              type: "tool_call",
              id: "call-1",
              name: "get_weather",
              argumentsText: '{"city":"Hangzhou"}',
            },
            {
              type: "tool_result",
              callId: "call-1",
              toolName: "get_weather",
              outcome: "success",
              content: [{ type: "text", text: '{"temp":28}' }],
            },
          ],
        }),
      ),
    );

    const contents = capturedBody?.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(contents.some((c) => c.parts.some((p) => "functionCall" in p))).toBe(true);
    const fr = contents.flatMap((c) => c.parts).find((p) => p.functionResponse);
    expect(fr?.functionResponse).toMatchObject({
      id: "call-1",
      name: "get_weather",
      response: { temp: 28 },
    });
  });
});

// ── reasoning / replay ────────────────────────────────────────

describe("GeminiAdapter - reasoning and replay", () => {
  it("should stream thought parts as reasoning events", async () => {
    const chunks = [
      dataLine({
        responseId: "resp-think",
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Let me think", thought: true, thoughtSignature: "sig-abc" }, { text: "Answer" }],
            },
            finishReason: "STOP",
            index: 0,
          },
        ],
      }),
    ];

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const events: string[] = [];
    for await (const event of adapter.stream(makeRequest())) {
      events.push(event.type);
    }

    expect(events).toContain("reasoning.started");
    expect(events).toContain("reasoning.delta");
    expect(events).toContain("reasoning.completed");
    expect(events).toContain("message.delta");

    const result = await collectStream(
      new GeminiAdapter({
        apiKey: "test-key",
        fetch: mockFetch(sseResponse(...chunks)),
      }).stream(makeRequest()),
    );
    expect(result.text).toBe("Answer");
    expect(result.output.some((item) => item.type === "reasoning")).toBe(true);

    const opaque = result.replay.find((item) => item.type === "opaque" && item.source === "gemini");
    expect(opaque).toBeDefined();
    if (opaque && opaque.type === "opaque") {
      const payload = opaque.payload as { content: { parts: Array<{ thoughtSignature?: string }> } };
      expect(payload.content.parts.some((p) => p.thoughtSignature === "sig-abc")).toBe(true);
    }
  });

  it("should restore opaque replay content with thoughtSignature", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: async (_url, init) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return sseResponse(
          dataLine({
            responseId: "resp-replay",
            candidates: [
              {
                content: { role: "model", parts: [{ text: "Next" }] },
                finishReason: "STOP",
                index: 0,
              },
            ],
          }),
        );
      },
    });

    await collectStream(
      adapter.stream(
        makeRequest({
          input: [
            { type: "message", role: "user", content: [{ type: "text", text: "Q1" }] },
            {
              type: "opaque",
              source: "gemini",
              purpose: "replay",
              payload: {
                replaceCanonical: true,
                content: {
                  role: "model",
                  parts: [{ text: "thought", thought: true, thoughtSignature: "sig-1" }, { text: "A1" }],
                },
              },
            },
            { type: "message", role: "user", content: [{ type: "text", text: "Q2" }] },
          ],
        }),
      ),
    );

    const contents = capturedBody?.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const model = contents.find((c) => c.role === "model");
    expect(model?.parts).toEqual([{ text: "thought", thought: true, thoughtSignature: "sig-1" }, { text: "A1" }]);
  });
});

// ── 请求构建 ──────────────────────────────────────────────────

describe("GeminiAdapter - request building", () => {
  it("should normalize models/ prefix and set auth header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> | undefined;
    const adapter = new GeminiAdapter({
      apiKey: "secret-key",
      fetch: async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = init.headers as Record<string, string>;
        return sseResponse(
          dataLine({
            responseId: "resp-url",
            candidates: [
              {
                content: { role: "model", parts: [{ text: "ok" }] },
                finishReason: "STOP",
                index: 0,
              },
            ],
          }),
        );
      },
    });

    await collectStream(adapter.stream(makeRequest({ model: "models/gemini-2.5-flash" })));
    expect(capturedUrl).toContain("/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    expect(capturedUrl).not.toContain("/models/models/");
    expect(capturedHeaders?.["x-goog-api-key"]).toBe("secret-key");
  });

  it("should map tools, toolChoice and reasoningLevel", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: async (_url, init) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return sseResponse(
          dataLine({
            responseId: "resp-cfg",
            candidates: [
              {
                content: { role: "model", parts: [{ text: "ok" }] },
                finishReason: "STOP",
                index: 0,
              },
            ],
          }),
        );
      },
    });

    await collectStream(
      adapter.stream(
        makeRequest({
          instructions: "Be concise",
          temperature: 0.2,
          maxOutputTokens: 128,
          reasoningLevel: "low",
          tools: [
            {
              name: "lookup",
              description: "Lookup",
              inputSchema: { type: "object", properties: { q: { type: "string" } } },
            },
            {
              name: "search",
              description: "Search",
              inputSchema: { type: "object", properties: { q: { type: "string" } } },
            },
          ],
          toolChoice: { type: "tool", name: "lookup" },
        }),
      ),
    );

    expect(capturedBody?.systemInstruction).toEqual({ parts: [{ text: "Be concise" }] });
    expect(capturedBody?.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "lookup",
            description: "Lookup",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
          {
            name: "search",
            description: "Search",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
      },
    ]);
    expect(capturedBody?.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] },
    });
    expect(capturedBody?.generationConfig).toEqual({
      temperature: 0.2,
      maxOutputTokens: 128,
      thinkingConfig: { includeThoughts: true, thinkingLevel: "LOW" },
    });
  });

  it("should reject unsupported reasoning levels", async () => {
    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: async () => {
        throw new Error("should not fetch");
      },
    });

    await expect(collectStream(adapter.stream(makeRequest({ reasoningLevel: "xhigh" })))).rejects.toMatchObject({
      name: "AIRequestError",
      code: "UNSUPPORTED_REASONING_LEVEL",
    });
    await expect(collectStream(adapter.stream(makeRequest({ reasoningLevel: "max" })))).rejects.toBeInstanceOf(
      AIRequestError,
    );
  });

  it("should apply headers and extraBody overrides", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      headers: { "x-goog-api-key": "override-key", "X-Custom": "yes" },
      extraBody: { cachedContent: "cachedContents/abc" },
      fetch: async (_url, init) => {
        capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
        capturedHeaders = init.headers as Record<string, string>;
        return sseResponse(
          dataLine({
            responseId: "resp-extra",
            candidates: [
              {
                content: { role: "model", parts: [{ text: "ok" }] },
                finishReason: "STOP",
                index: 0,
              },
            ],
          }),
        );
      },
    });

    await collectStream(adapter.stream(makeRequest()));
    expect(capturedBody?.cachedContent).toBe("cachedContents/abc");
    expect(capturedHeaders?.["x-goog-api-key"]).toBe("override-key");
    expect(capturedHeaders?.["X-Custom"]).toBe("yes");
  });

  it("should reject unsupported image content blocks", async () => {
    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: async () => {
        throw new Error("should not fetch");
      },
    });

    await expect(
      collectStream(
        adapter.stream(
          makeRequest({
            input: [
              {
                type: "message",
                role: "user",
                content: [{ type: "image", imageUrl: "https://example.com/a.png" }],
              },
            ],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CONTENT_BLOCK" });
  });
});

// ── 错误 / 流异常 ─────────────────────────────────────────────

describe("GeminiAdapter - errors and stream edge cases", () => {
  it("should throw AIProviderError on HTTP failure", async () => {
    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: async () => new Response(JSON.stringify({ error: { message: "nope" } }), { status: 401 }),
    });

    await expect(collectStream(adapter.stream(makeRequest()))).rejects.toBeInstanceOf(AIProviderError);
  });

  it("should emit warning for malformed SSE data", async () => {
    const chunks = [
      "data: {bad json}\n",
      dataLine({
        responseId: "resp-malformed",
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Hi" }] },
            finishReason: "STOP",
            index: 0,
          },
        ],
      }),
    ];

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest({ include: { billing: "off" } })));
    expect(result.warnings?.some((w) => w.includes("malformed"))).toBe(true);
    expect(result.text).toBe("Hi");
  });

  it("should handle incomplete stream without finishReason", async () => {
    const chunks = [
      dataLine({
        responseId: "resp-partial",
        candidates: [{ content: { role: "model", parts: [{ text: "Partial" }] }, index: 0 }],
      }),
    ];

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest({ include: { billing: "off" } })));
    expect(result.text).toBe("Partial");
    expect(result.warnings?.some((w) => w.includes("without a finishReason"))).toBe(true);
  });

  it("should honor abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: async () => {
        throw new Error("should not fetch when already aborted");
      },
    });

    await expect(collectStream(adapter.stream(makeRequest({ signal: controller.signal })))).rejects.toBeInstanceOf(
      DOMException,
    );
  });

  it("should emit completed only once when finishReason repeats", async () => {
    const chunks = [
      dataLine({
        responseId: "resp-dup",
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Hi" }] },
            finishReason: "STOP",
            index: 0,
          },
        ],
      }),
      dataLine({
        responseId: "resp-dup",
        candidates: [{ finishReason: "STOP", index: 0 }],
      }),
    ];

    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const eventTypes: string[] = [];
    for await (const event of adapter.stream(makeRequest())) {
      eventTypes.push(event.type);
    }

    expect(eventTypes.filter((type) => type === "response.completed")).toHaveLength(1);
    expect(eventTypes).toContain("response.warning");
  });
});

// ── 适配器属性 ────────────────────────────────────────────────

describe("GeminiAdapter - properties", () => {
  it("should have correct kind and stream source", () => {
    const adapter = new GeminiAdapter({ apiKey: "test-key" });
    expect(adapter.kind).toBe("gemini");
    expect(adapter.isSyntheticStream).toBe(false);
  });
});

describe("GeminiAdapter - serverTools guard", () => {
  it("should reject serverTools with UNSUPPORTED_SERVER_TOOL", async () => {
    const adapter = new GeminiAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse("data: {}\n\n")),
    });

    await expect(
      collectStream(
        adapter.stream(
          makeRequest({
            serverTools: [{ type: "web_search" }],
          }),
        ),
      ),
    ).rejects.toMatchObject({
      name: "AIRequestError",
      code: "UNSUPPORTED_SERVER_TOOL",
    });
  });
});
