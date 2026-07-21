/**
 * ResponsesAdapter 测试
 *
 * 使用 mock fetch 注入 SSE 数据，不需要真实 API key。
 */

import { describe, it, expect } from "bun:test";
import { AIProviderError, AIRequestError, ResponsesAdapter, collectStream } from "../../src/index.js";
import type { NormalizedRequest, FetchFn } from "../../src/index.js";
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

  it("should preserve UTF-8 characters split across transport chunks", async () => {
    const encoder = new TextEncoder();
    const prefix = encoder.encode(
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\nevent: response.output_text.delta\ndata: {"item_id":"m1","delta":"',
    );
    const text = encoder.encode("你好");
    const suffix = encoder.encode(
      '"}\n\nevent: response.output_text.done\ndata: {"item_id":"m1","text":"你好"}\n\nevent: response.completed\ndata: {"response":{"id":"resp-utf8","model":"gpt-4o","output":[{"id":"m1","type":"message"}]}}\n\n',
    );
    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: async () => byteChunksResponse(prefix, text.slice(0, 1), text.slice(1, 4), text.slice(4), suffix),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("你好");
    expect(result.stopReason).toBe("end_turn");
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

  it("should stream modern reasoning_summary_* events without UNKNOWN_PROVIDER_EVENT", async () => {
    const sse = [
      'event: response.created\ndata: {"response":{"id":"resp-rs","model":"o3","output":[]}}\n\n',
      'event: response.in_progress\ndata: {"response":{"id":"resp-rs","model":"o3","output":[]}}\n\n',
      'event: response.output_item.added\ndata: {"item":{"id":"rs1","type":"reasoning","summary":[]}}\n\n',
      'event: response.reasoning_summary_part.added\ndata: {"item_id":"rs1","summary_index":0,"part":{"type":"summary_text","text":""}}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"item_id":"rs1","summary_index":0,"delta":"Step 1"}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"item_id":"rs1","summary_index":0,"delta":" then 2"}\n\n',
      'event: response.reasoning_summary_text.done\ndata: {"item_id":"rs1","summary_index":0,"text":"Step 1 then 2"}\n\n',
      'event: response.reasoning_summary_part.done\ndata: {"item_id":"rs1","summary_index":0,"part":{"type":"summary_text","text":"Step 1 then 2"}}\n\n',
      `event: response.output_item.done\ndata: ${JSON.stringify({
        item: {
          id: "rs1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Step 1 then 2" }],
        },
      })}\n\n`,
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.delta\ndata: {"item_id":"m1","delta":"42"}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"42"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          id: "resp-rs",
          model: "o3",
          output: [
            {
              id: "rs1",
              type: "reasoning",
              summary: [{ type: "summary_text", text: "Step 1 then 2" }],
            },
            { id: "m1", type: "message", content: [{ type: "output_text", text: "42" }] },
          ],
        },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest({ model: "o3" })));

    expect(result.warnings?.some((w) => w.message.includes("unknown event type")) ?? false).toBe(false);
    expect(result.output).toHaveLength(2);
    expect(result.output[0]!.type).toBe("reasoning");
    if (result.output[0]!.type === "reasoning") {
      expect(result.output[0]!.visibility).toBe("summary");
      expect(result.output[0]!.content).toEqual([{ type: "text", text: "Step 1 then 2" }]);
    }
    expect(result.text).toBe("42");
  });

  it("should produce tool_call events", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"fc_1","type":"function_call","call_id":"call_weather","name":"get_weather"}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"item_id":"fc_1","delta":"{\\"city\\":\\"Hangzhou\\"}"}\n\n',
      'event: response.function_call_arguments.done\ndata: {"item_id":"fc_1","arguments":"{\\"city\\":\\"Hangzhou\\"}"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          id: "resp-tc",
          model: "gpt-4o",
          output: [{ id: "fc_1", type: "function_call", call_id: "call_weather", name: "get_weather" }],
        },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.id).toBe("call_weather");
    expect(result.toolCalls[0]!.name).toBe("get_weather");
    expect(result.toolCalls[0]!.argumentsText).toBe('{"city":"Hangzhou"}');
  });

  it("should infer stop_reason as tool_call when function_call present", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"tc1","type":"function_call","name":"search"}}\n\n',
      'event: response.function_call_arguments.done\ndata: {"item_id":"tc1","arguments":"{}"}\n\n',
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

  it("should include tools in request body with parameters (not input_schema)", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });
    const inputSchema = {
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
    };

    await collectStream(
      adapter.stream(
        makeRequest({
          tools: [{ name: "get_weather", description: "Get weather", inputSchema }],
        }),
      ),
    );
    const body = captured.current as Record<string, unknown> | null;
    const tools = body?.tools as Array<Record<string, unknown>> | undefined;
    expect(tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: inputSchema,
      },
    ]);
    expect(tools?.[0]).not.toHaveProperty("input_schema");
  });

  it("should merge function tools and serverTools into Responses tools array", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });
    const inputSchema = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    };

    await collectStream(
      adapter.stream(
        makeRequest({
          tools: [{ name: "get_weather", description: "Get weather", inputSchema }],
          serverTools: [
            {
              type: "web_search",
              allowedDomains: ["example.com"],
              userLocation: { type: "approximate", country: "CN", city: "Hangzhou" },
              searchContextSize: "low",
            },
            {
              type: "code_execution",
              container: { type: "auto", memoryLimit: "4g", fileIds: ["file-1"] },
            },
            {
              type: "mcp",
              serverLabel: "dmcp",
              serverUrl: "https://dmcp-server.example/mcp",
              serverDescription: "dice",
              authorization: "secret-token",
              allowedTools: ["roll"],
              requireApproval: "never",
            },
          ],
        }),
      ),
    );

    const body = captured.current as Record<string, unknown> | null;
    expect(body?.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: inputSchema,
      },
      {
        type: "web_search",
        filters: { allowed_domains: ["example.com"] },
        user_location: { type: "approximate", country: "CN", city: "Hangzhou" },
        search_context_size: "low",
      },
      {
        type: "code_interpreter",
        container: { type: "auto", memory_limit: "4g", file_ids: ["file-1"] },
      },
      {
        type: "mcp",
        server_label: "dmcp",
        server_url: "https://dmcp-server.example/mcp",
        server_description: "dice",
        authorization: "secret-token",
        allowed_tools: ["roll"],
        require_approval: "never",
      },
    ]);
  });

  it("should default code_execution container to auto when omitted", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(
      adapter.stream(
        makeRequest({
          serverTools: [{ type: "code_execution" }],
        }),
      ),
    );

    const body = captured.current as Record<string, unknown> | null;
    expect(body?.tools).toEqual([
      {
        type: "code_interpreter",
        container: { type: "auto" },
      },
    ]);
  });

  it("should omit reasoning when reasoningLevel is unset", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(adapter.stream(makeRequest()));
    const body = captured.current as Record<string, unknown> | null;
    expect(body).not.toHaveProperty("reasoning");
  });

  it("should map reasoningLevel to reasoning.effort", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(adapter.stream(makeRequest({ reasoningLevel: "high" })));
    const body = captured.current as Record<string, unknown> | null;
    expect(body?.reasoning).toEqual({ effort: "high" });
  });

  it("should let extraBody override mapped reasoning", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch,
      extraBody: { reasoning: { effort: "medium", summary: "detailed" } },
    });

    await collectStream(adapter.stream(makeRequest({ reasoningLevel: "high" })));
    const body = captured.current as Record<string, unknown> | null;
    expect(body?.reasoning).toEqual({ effort: "medium", summary: "detailed" });
  });

  it("should include temperature and max_output_tokens", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(adapter.stream(makeRequest({ temperature: 0.5, maxOutputTokens: 100 })));
    const body = captured.current as Record<string, unknown> | null;
    expect(body?.temperature).toBe(0.5);
    expect(body?.max_output_tokens).toBe(100);
  });

  it("should merge custom headers and extraBody from constructor options", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: Record<string, unknown> | undefined;

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      headers: {
        Authorization: "Bearer override-key",
        "X-Custom-Header": "custom-value",
      },
      extraBody: {
        top_p: 0.9,
        temperature: 0.1,
      },
      fetch: async (_url, init) => {
        capturedHeaders = init.headers as Record<string, string>;
        capturedBody = JSON.parse(init.body as string);
        return sseResponse(
          `event: response.completed\ndata: ${JSON.stringify({ response: { id: "r", model: "gpt-4o", output: [] } })}\n\n`,
        );
      },
    });

    await collectStream(adapter.stream(makeRequest({ temperature: 0.5 })));
    expect(capturedHeaders?.Authorization).toBe("Bearer override-key");
    expect(capturedHeaders?.["X-Custom-Header"]).toBe("custom-value");
    expect(capturedHeaders?.["Content-Type"]).toBe("application/json");
    expect(capturedBody?.top_p).toBe(0.9);
    expect(capturedBody?.temperature).toBe(0.1);
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

  it("should map rejected tool results without rejecting canonical input", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(
      adapter.stream(
        makeRequest({
          input: [
            {
              type: "tool_result",
              callId: "tc1",
              toolName: "get_weather",
              outcome: "rejected",
              content: [{ type: "text", text: "permission denied" }],
            },
          ],
        }),
      ),
    );

    const body = captured.current as Record<string, unknown> | null;
    expect(body?.input).toEqual([
      {
        type: "function_call_output",
        call_id: "tc1",
        output: "permission denied",
      },
    ]);
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

  it("should prefer canonical replay items over opaque previous_response_id", async () => {
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
      // EasyInputMessage: assistant content 必须是 string / input_* parts，不是 { type: "text" }
      { type: "message", role: "assistant", content: "Hi" },
    ]);
    expect(body).not.toHaveProperty("previous_response_id");
  });

  it("should map opaque response id to previous_response_id (not item_reference)", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(
      adapter.stream(
        makeRequest({
          input: [
            { type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] },
            {
              type: "opaque" as const,
              source: "responses",
              purpose: "replay",
              payload: { id: "resp-only-opaque" },
            },
          ],
        }),
      ),
    );

    const body = captured.current as Record<string, unknown> | null;
    expect(body?.input).toEqual([{ type: "message", role: "user", content: "Hello" }]);
    expect(body?.previous_response_id).toBe("resp-only-opaque");
  });

  it("should serialize function_call with required call_id", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(
      adapter.stream(
        makeRequest({
          input: [
            { type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "weather?" }] },
            {
              type: "tool_call" as const,
              id: "call_abc",
              name: "get_weather",
              argumentsText: '{"city":"Hangzhou"}',
            },
            {
              type: "tool_result" as const,
              callId: "call_abc",
              toolName: "get_weather",
              outcome: "success" as const,
              content: [{ type: "text" as const, text: "28C sunny" }],
            },
          ],
        }),
      ),
    );

    const body = captured.current as Record<string, unknown> | null;
    expect(body?.input).toEqual([
      { type: "message", role: "user", content: "weather?" },
      {
        type: "function_call",
        call_id: "call_abc",
        name: "get_weather",
        arguments: '{"city":"Hangzhou"}',
      },
      {
        type: "function_call_output",
        call_id: "call_abc",
        output: "28C sunny",
      },
    ]);
  });

  it("should serialize reasoning with id + summary_text (not legacy content blocks)", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });

    await collectStream(
      adapter.stream(
        makeRequest({
          input: [
            {
              type: "reasoning" as const,
              id: "rs_1",
              visibility: "summary" as const,
              content: [{ type: "text" as const, text: "step by step" }],
            },
            { type: "message" as const, role: "assistant" as const, content: [{ type: "text" as const, text: "42" }] },
          ],
        }),
      ),
    );

    const body = captured.current as Record<string, unknown> | null;
    expect(body?.input).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "step by step" }],
      },
      { type: "message", role: "assistant", content: "42" },
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

  it("should sanitize HTML HTTP error bodies", async () => {
    const html = "<!DOCTYPE html><html>secret</html>";
    const adapter = new ResponsesAdapter({
      apiKey: "bad-key",
      fetch: async () => new Response(html, { status: 502 }),
    });

    try {
      await collectStream(adapter.stream(makeRequest()));
      expect.unreachable("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AIProviderError);
      const e = err as AIProviderError;
      expect(e.responseBody).toContain("Body omitted");
      expect(e.message).toContain("Provider returned 502");
    }
  });

  it("should reject non-string opaque continuation id", async () => {
    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });

    await expect(
      collectStream(
        adapter.stream(
          makeRequest({
            input: [
              {
                type: "opaque",
                source: "responses",
                purpose: "replay",
                payload: { id: 12345 },
              },
            ],
          }),
        ),
      ),
    ).rejects.toMatchObject({ name: "AIRequestError", code: "INVALID_OPAQUE_REPLAY" });
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
    expect(result.warnings?.some((w) => w.message.includes("Rate limit exceeded"))).toBe(true);
  });

  it("should warn once on unknown SSE event types without aborting", async () => {
    const sse = [
      'event: response.future_feature\ndata: {"foo":1}\n\n',
      'event: response.future_feature\ndata: {"foo":2}\n\n',
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"ok"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: { id: "resp-unknown", model: "gpt-4o", output: [{ id: "m1", type: "message" }] },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("ok");
    const unknownWarnings = (result.warnings ?? []).filter((w) => w.message.includes("unknown event type"));
    expect(unknownWarnings).toHaveLength(1);
  });

  it("should map response.failed to stopReason error and emit PROVIDER_FAILURE warning", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"partial"}\n\n',
      `event: response.failed\ndata: ${JSON.stringify({
        response: {
          id: "resp-failed",
          model: "gpt-4o",
          status: "failed",
          error: { message: "upstream timeout" },
          output: [{ id: "m1", type: "message", content: [{ type: "text", text: "partial" }] }],
        },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.stopReason).toBe("error");
    expect(result.backend.rawResponseId).toBe("resp-failed");
    expect(result.warnings?.some((w) => w.message.includes("Response failed") || w.message.includes("upstream timeout"))).toBe(true);
  });

  it("should map response.incomplete max_output_tokens to stopReason", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"cut off"}\n\n',
      `event: response.incomplete\ndata: ${JSON.stringify({
        response: {
          id: "resp-incomplete",
          model: "gpt-4o",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ id: "m1", type: "message", status: "incomplete" }],
        },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.stopReason).toBe("max_output_tokens");
    expect(result.backend.rawResponseId).toBe("resp-incomplete");
  });

  it("should map incomplete content_filter reason", async () => {
    const sse = [
      `event: response.incomplete\ndata: ${JSON.stringify({
        response: {
          id: "resp-cf",
          model: "gpt-4o",
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
          output: [],
        },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.stopReason).toBe("content_filter");
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
    expect(result.warnings?.some((w) => w.message.includes("Billing information"))).toBeFalsy();
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
    expect(result.warnings?.some((w) => w.message.includes("malformed Responses SSE"))).toBe(true);
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

// ── Server tools streaming ────────────────────────────────────

describe("ResponsesAdapter - server tools streaming", () => {
  it("should map web_search_call and message url citations", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"ws_1","type":"web_search_call","status":"in_progress","action":{"type":"search","query":"Hangzhou weather"}}}\n\n',
      'event: response.web_search_call.searching\ndata: {"item_id":"ws_1"}\n\n',
      'event: response.output_item.done\ndata: {"item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"type":"search","query":"Hangzhou weather","sources":[{"type":"url","url":"https://example.com"}]}}}\n\n',
      'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
      'event: response.output_text.delta\ndata: {"item_id":"m1","delta":"Sunny in Hangzhou."}\n\n',
      'event: response.output_text.annotation.added\ndata: {"item_id":"m1","annotation":{"type":"url_citation","url":"https://example.com","title":"Weather","start_index":0,"end_index":5}}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m1","text":"Sunny in Hangzhou."}\n\n',
      'event: response.output_item.done\ndata: {"item":{"id":"m1","type":"message","content":[{"type":"output_text","text":"Sunny in Hangzhou.","annotations":[{"type":"url_citation","url":"https://example.com","title":"Weather","start_index":0,"end_index":5}]}]}}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          id: "resp-web",
          model: "gpt-4o",
          status: "completed",
          output: [
            {
              id: "ws_1",
              type: "web_search_call",
              status: "completed",
              action: { type: "search", query: "Hangzhou weather" },
            },
            { id: "m1", type: "message" },
          ],
        },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.serverToolCalls).toHaveLength(1);
    expect(result.serverToolCalls[0]).toMatchObject({
      id: "ws_1",
      tool: "web_search",
      name: "search",
      argumentsText: '{"query":"Hangzhou weather"}',
      status: "completed",
    });
    expect(result.serverToolResults).toHaveLength(1);
    expect(result.serverToolResults[0]).toMatchObject({
      callId: "ws_1",
      tool: "web_search",
      outcome: "success",
    });
    const message = result.output.find((item) => item.type === "message");
    expect(message && message.type === "message" ? message.citations : undefined).toEqual([
      {
        type: "url",
        url: "https://example.com",
        title: "Weather",
        startIndex: 0,
        endIndex: 5,
      },
    ]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.text).toBe("Sunny in Hangzhou.");
    expect((result.warnings ?? []).some((w) => w.message.includes("UNKNOWN_PROVIDER_EVENT"))).toBe(false);
  });

  it("should map code_interpreter_call code stream and outputs", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"ci_1","type":"code_interpreter_call","status":"in_progress","container_id":"cntr_1"}}\n\n',
      'event: response.code_interpreter_call_code.delta\ndata: {"item_id":"ci_1","delta":"print(1+1)"}\n\n',
      'event: response.code_interpreter_call_code.done\ndata: {"item_id":"ci_1","code":"print(1+1)"}\n\n',
      'event: response.output_item.done\ndata: {"item":{"id":"ci_1","type":"code_interpreter_call","status":"completed","container_id":"cntr_1","code":"print(1+1)","outputs":[{"type":"logs","logs":"2\\n"}]}}\n\n',
      'event: response.output_item.added\ndata: {"item":{"id":"m2","type":"message"}}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m2","text":"2"}\n\n',
      'event: response.output_text.annotation.added\ndata: {"item_id":"m2","annotation":{"type":"container_file_citation","container_id":"cntr_1","file_id":"cfile_1","filename":"plot.png","start_index":0,"end_index":1}}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          id: "resp-code",
          model: "gpt-4o",
          status: "completed",
          output: [
            { id: "ci_1", type: "code_interpreter_call", status: "completed" },
            { id: "m2", type: "message" },
          ],
        },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.serverToolCalls[0]).toMatchObject({
      id: "ci_1",
      tool: "code_execution",
      name: "python",
      argumentsText: "print(1+1)",
      status: "completed",
    });
    expect(result.serverToolResults[0]).toMatchObject({
      callId: "ci_1",
      tool: "code_execution",
      outcome: "success",
    });
    expect(result.serverToolResults[0]!.content).toEqual([{ type: "text", text: "2\n" }]);
    expect(result.stopReason).toBe("end_turn");
  });

  it("should map mcp_list_tools discovery and mcp_call result", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"mcpl_1","type":"mcp_list_tools","server_label":"dmcp"}}\n\n',
      'event: response.output_item.done\ndata: {"item":{"id":"mcpl_1","type":"mcp_list_tools","server_label":"dmcp","tools":[{"name":"roll","description":"Roll dice","input_schema":{"type":"object"}}]}}\n\n',
      'event: response.output_item.added\ndata: {"item":{"id":"mcp_1","type":"mcp_call","name":"roll","server_label":"dmcp","arguments":"{\\"diceRollExpression\\":\\"2d4+1\\"}"}}\n\n',
      'event: response.mcp_call_arguments.delta\ndata: {"item_id":"mcp_1","delta":"{\\"diceRollExpression\\":\\"2d4+1\\"}"}\n\n',
      'event: response.output_item.done\ndata: {"item":{"id":"mcp_1","type":"mcp_call","name":"roll","server_label":"dmcp","arguments":"{\\"diceRollExpression\\":\\"2d4+1\\"}","output":"4","error":null}}\n\n',
      'event: response.output_item.added\ndata: {"item":{"id":"m3","type":"message"}}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m3","text":"You rolled 4."}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          id: "resp-mcp",
          model: "gpt-4o",
          status: "completed",
          output: [
            { id: "mcpl_1", type: "mcp_list_tools", server_label: "dmcp", tools: [] },
            { id: "mcp_1", type: "mcp_call", name: "roll", server_label: "dmcp" },
            { id: "m3", type: "message" },
          ],
        },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.output.map((item) => item.type)).toEqual([
      "server_tool_discovery",
      "server_tool_call",
      "server_tool_result",
      "message",
    ]);
    const discovery = result.output.find((item) => item.type === "server_tool_discovery");
    expect(discovery).toMatchObject({
      id: "mcpl_1",
      tool: "mcp",
      serverLabel: "dmcp",
      tools: [{ name: "roll", description: "Roll dice", inputSchema: { type: "object" } }],
    });
    expect(result.serverToolCalls[0]).toMatchObject({
      id: "mcp_1",
      tool: "mcp",
      name: "roll",
      serverLabel: "dmcp",
      argumentsText: '{"diceRollExpression":"2d4+1"}',
    });
    expect(result.serverToolResults[0]).toMatchObject({
      callId: "mcp_1",
      tool: "mcp",
      outcome: "success",
    });
    expect(result.serverToolResults[0]!.content).toEqual([{ type: "text", text: "4" }]);
    expect(result.stopReason).toBe("end_turn");
  });

  it("should warn on mcp_approval_request without aborting", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"mcpr_1","type":"mcp_approval_request","name":"roll","server_label":"dmcp","arguments":"{}"}}\n\n',
      'event: response.output_item.done\ndata: {"item":{"id":"mcpr_1","type":"mcp_approval_request","name":"roll","server_label":"dmcp","arguments":"{}"}}\n\n',
      'event: response.output_item.added\ndata: {"item":{"id":"m4","type":"message"}}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m4","text":"Need approval."}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          id: "resp-approval",
          model: "gpt-4o",
          status: "completed",
          output: [
            { id: "mcpr_1", type: "mcp_approval_request" },
            { id: "m4", type: "message" },
          ],
        },
      })}\n\n`,
    ];

    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect((result.warnings ?? []).some((w) => w.message.includes("MCP approval"))).toBe(true);
    expect(result.text).toBe("Need approval.");
    expect(result.stopReason).toBe("end_turn");
  });
});
