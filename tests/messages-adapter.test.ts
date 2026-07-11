/**
 * MessagesAdapter 测试
 *
 * 使用 mock fetch 注入 Anthropic Message API 的 SSE 数据。
 */

import { describe, it, expect } from "bun:test";
import { AIRequestError, MessagesAdapter, collectStream } from "../src/index.js";

import type { NormalizedRequest, FetchFn } from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────

function sseResponse(...chunks: string[]): Response {
  return sseResponseWithHeaders({}, ...chunks);
}

function sseResponseWithHeaders(headers: Record<string, string>, ...chunks: string[]): Response {
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
    headers: { "Content-Type": "text/event-stream", ...headers },
  });
}

function mockFetch(resp: Response): FetchFn {
  return async () => resp;
}

function makeRequest(overrides?: Partial<NormalizedRequest>): NormalizedRequest {
  return {
    model: "claude-3-opus-20240229",
    requestId: "test-req-1",
    input: [{ type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }],
    ...overrides,
  };
}

/** 构建 message_stop 的 SSE 数据 */
function messageStopSSE(): string {
  return `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
}

// ── 文本流 ────────────────────────────────────────────────────

describe("MessagesAdapter - text streaming", () => {
  it("should produce message events from a text response", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-3-opus", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 2 } })}\n\n`,
      messageStopSSE(),
    ];

    const adapter = new MessagesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("Hello world");
    expect(result.output).toHaveLength(1);
    expect(result.output[0]!.type).toBe("message");
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(2);
    expect(result.stopReason).toBe("end_turn");
  });

  it("should handle SSE events split across transport chunks", async () => {
    const chunks = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_split", type: "message", role: "assistant", model: "claude-3-opus", content: [], stop_reason: null, usage: { input_tokens: 8, output_tokens: 0 } } }).slice(0, 90)}`,
      `${JSON.stringify({ type: "message_start", message: { id: "msg_split", type: "message", role: "assistant", model: "claude-3-opus", content: [], stop_reason: null, usage: { input_tokens: 8, output_tokens: 0 } } }).slice(90)}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }).slice(0, 40)}`,
      `${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }).slice(40)}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }).slice(0, 45)}`,
      `${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }).slice(45)}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " split" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 8, output_tokens: 2 } }).slice(0, 55)}`,
      `${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 8, output_tokens: 2 } }).slice(55)}\n\n`,
      "event: message_stop\nda",
      'ta: {"type":"message_stop"}\n\n',
    ];

    const adapter = new MessagesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...chunks)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.text).toBe("Hello split");
    expect(result.output).toHaveLength(1);
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage?.inputTokens).toBe(8);
    expect(result.usage?.outputTokens).toBe(2);
  });

  it("should handle reasoning (thinking) blocks", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_2", type: "message", role: "assistant", model: "claude-3-opus", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
      // thinking block
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Step 1..." } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      // text block
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 5 } })}\n\n`,
      messageStopSSE(),
    ];

    const adapter = new MessagesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.output).toHaveLength(2);
    expect(result.output[0]!.type).toBe("reasoning");
    expect(result.output[1]!.type).toBe("message");
    if (result.output[0]!.type === "reasoning") {
      expect(result.output[0]!.visibility).toBe("full");
    }
    expect(result.text).toBe("Answer");
  });

  it("should handle redacted_thinking blocks", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_3", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "REDACTED_DATA" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 3 } })}\n\n`,
      messageStopSSE(),
    ];

    const adapter = new MessagesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.output).toHaveLength(2);
    expect(result.output[0]!.type).toBe("reasoning");
    if (result.output[0]!.type === "reasoning") {
      expect(result.output[0]!.visibility).toBe("redacted");
    }
    expect(result.text).toBe("Hi");
  });

  it("should produce tool_call events", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_4", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_123", name: "get_weather", input: {} } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":"Hangzhou"}' } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 5 } })}\n\n`,
      messageStopSSE(),
    ];

    const adapter = new MessagesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("get_weather");
    expect(result.toolCalls[0]!.argumentsText).toBe('{"city":"Hangzhou"}');
    expect(result.stopReason).toBe("tool_call");
  });

  it("should include replay with opaque continuation", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_r", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 5, output_tokens: 1 } })}\n\n`,
      messageStopSSE(),
    ];

    const adapter = new MessagesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.replay.length).toBeGreaterThanOrEqual(1);
    expect(result.replay[0]!.type).toBe("message");
    // 应包含 opaque replay item
    const opaqueReplay = result.replay.find((r) => r.type === "opaque");
    expect(opaqueReplay).toBeDefined();
    if (opaqueReplay?.type === "opaque") {
      expect(opaqueReplay.source).toBe("messages");
      expect(opaqueReplay.purpose).toBe("replay");
    }
  });

  it("should collect usage source and provider metadata", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_meta", type: "message", role: "assistant", model: "claude-3-opus", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 2 } })}\n\n`,
      messageStopSSE(),
    ];

    const adapter = new MessagesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(
        sseResponseWithHeaders(
          {
            "request-id": "req_hdr_123",
            "anthropic-ratelimit-requests-limit": "1000",
          },
          ...sse,
        ),
      ),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.auxiliary?.usageSource).toBe("stream");
    expect(result.auxiliary?.providerUsage).toEqual({ input_tokens: 10, output_tokens: 2 });
    expect(result.backend.metadataSources).toEqual(["header", "stream"]);

    const providerMetadata = result.auxiliary?.providerMetadata as Record<string, unknown> | undefined;
    expect(providerMetadata?.apiVersion).toBe("2023-06-01");

    const headers = providerMetadata?.headers as Record<string, unknown> | undefined;
    expect(headers?.["request-id"]).toBe("req_hdr_123");
    expect(headers?.["anthropic-ratelimit-requests-limit"]).toBe("1000");

    const message = providerMetadata?.message as Record<string, unknown> | undefined;
    expect(message?.id).toBe("msg_meta");
    expect(message?.model).toBe("claude-3-opus");
  });
});

// ── 请求构建 ──────────────────────────────────────────────────

describe("MessagesAdapter - request building", () => {
  function captureRequest(): { captured: { current: object | null }; fetch: FetchFn } {
    const captured: { current: object | null } = { current: null };
    return {
      captured,
      fetch: async (_url: string, init: RequestInit) => {
        captured.current = JSON.parse(init.body as string);
        const finish = [
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 1 } })}\n\n`,
          messageStopSSE(),
        ];
        return sseResponse(...finish);
      },
    };
  }

  it("should include model and messages in request body", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new MessagesAdapter({ apiKey: "test-key", fetch });

    await collectStream(adapter.stream(makeRequest({ model: "claude-3-opus-20240229" })));
    const body = captured.current as Record<string, unknown> | null;
    expect(body?.model).toBe("claude-3-opus-20240229");
    expect(body?.stream).toBe(true);
    expect(body?.messages).toBeDefined();
    expect(body?.max_tokens).toBeDefined();
  });

  it("should include system prompt from instructions", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new MessagesAdapter({ apiKey: "test-key", fetch });

    await collectStream(adapter.stream(makeRequest({ instructions: "Be helpful." })));
    const body = captured.current as Record<string, unknown> | null;
    expect(body?.system).toBe("Be helpful.");
  });

  it("should include instruction blocks as system prompt text", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new MessagesAdapter({ apiKey: "test-key", fetch });

    await collectStream(
      adapter.stream(
        makeRequest({
          instructions: [
            { type: "text", text: "Be concise." },
            { type: "json", json: { format: "json" } },
          ],
        }),
      ),
    );
    const body = captured.current as Record<string, unknown> | null;
    expect(body?.system).toBe('Be concise.\n{"format":"json"}');
  });

  it("should map tool_call to tool_use block", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new MessagesAdapter({ apiKey: "test-key", fetch });

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
    // 最后一条消息应该是 assistant 消息包含 tool_use block
    const messages = (body?.messages as Array<Record<string, unknown>> | undefined) ?? [];
    const lastMsg = messages[messages.length - 1];
    const content = (lastMsg?.content as Array<Record<string, unknown>> | undefined) ?? [];
    expect(lastMsg?.role).toBe("assistant");
    expect(content[0]?.type).toBe("tool_use");
  });

  it("should tolerate non-JSON tool_call argumentsText", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new MessagesAdapter({ apiKey: "test-key", fetch });

    await collectStream(
      adapter.stream(
        makeRequest({
          input: [{ type: "tool_call" as const, id: "tc1", name: "get_weather", argumentsText: '{"city":' }],
        }),
      ),
    );
    const body = captured.current as Record<string, unknown> | null;
    const messages = (body?.messages as Array<Record<string, unknown>> | undefined) ?? [];
    const lastMsg = messages[messages.length - 1];
    const content = (lastMsg?.content as Array<Record<string, unknown>> | undefined) ?? [];
    expect(lastMsg?.role).toBe("assistant");
    expect(content[0]).toEqual({
      type: "tool_use",
      id: "tc1",
      name: "get_weather",
      input: {},
    });
  });

  it("should map tool_result to user message with tool_result block", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new MessagesAdapter({ apiKey: "test-key", fetch });

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
    const messages = (body?.messages as Array<Record<string, unknown>> | undefined) ?? [];
    const lastMsg = messages[messages.length - 1];
    const content = (lastMsg?.content as Array<Record<string, unknown>> | undefined) ?? [];
    expect(lastMsg?.role).toBe("user");
    expect(content[0]?.type).toBe("tool_result");
  });

  it("should include tool_choice when provided", async () => {
    const { captured, fetch } = captureRequest();
    const adapter = new MessagesAdapter({ apiKey: "test-key", fetch });

    await collectStream(
      adapter.stream(
        makeRequest({
          tools: [{ name: "get_weather", inputSchema: {} }],
          toolChoice: { type: "tool" as const, name: "get_weather" },
        }),
      ),
    );

    const body = captured.current as Record<string, unknown> | null;
    expect(body?.tool_choice).toEqual({ type: "tool", name: "get_weather" });
  });

  it("should reject unsupported image content instead of coercing it to text", async () => {
    const { fetch } = captureRequest();
    const adapter = new MessagesAdapter({ apiKey: "test-key", fetch });

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
    const { fetch } = captureRequest();
    const adapter = new MessagesAdapter({ apiKey: "test-key", fetch });

    const result = await collectStream(adapter.stream(makeRequest({ metadata: { traceId: "trace-1" } })));
    expect(result.warnings?.some((w) => w.includes("Request metadata is not supported"))).toBe(true);
  });

  it("should round-trip replay into a single assistant message with raw content blocks", async () => {
    const round1SSE = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_rt_1", type: "message", role: "assistant", model: "claude-3-opus", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll check." } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "get_weather", input: {} } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":"Hangzhou"}' } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 4 } })}\n\n`,
      messageStopSSE(),
    ];
    const round1Adapter = new MessagesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...round1SSE)),
    });
    const round1 = await collectStream(
      round1Adapter.stream(
        makeRequest({
          input: [
            { type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "weather?" }] },
          ],
        }),
      ),
    );

    const { captured, fetch } = captureRequest();
    const round2Adapter = new MessagesAdapter({ apiKey: "test-key", fetch });
    await collectStream(
      round2Adapter.stream(
        makeRequest({
          input: [
            { type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "weather?" }] },
            ...round1.replay,
            {
              type: "tool_result" as const,
              callId: "tu_1",
              toolName: "get_weather",
              outcome: "success" as const,
              content: [{ type: "text" as const, text: "Sunny" }],
            },
          ],
        }),
      ),
    );

    const body = captured.current as Record<string, unknown> | null;
    expect(body?.messages).toEqual([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll check." },
          { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Hangzhou" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "Sunny", is_error: false }],
      },
    ]);
  });
});

// ── 合成 ID 唯一性 ───────────────────────────────────────────

describe("MessagesAdapter - synthetic item IDs", () => {
  it("should produce unique IDs across multi-round tool loops by namespacing with rawResponseId", async () => {
    // 第 1 轮: response id = "msg_R1", 两个 content block (thinking@0, text@1)
    const round1SSE = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_R1", type: "message", role: "assistant", model: "claude-3-opus", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "..." } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Round1" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 4 } })}\n\n`,
      messageStopSSE(),
    ];
    const adapter1 = new MessagesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...round1SSE)),
    });
    const result1 = await collectStream(adapter1.stream(makeRequest()));

    // 第 2 轮: response id = "msg_R2", 同样索引的 content block
    const round2SSE = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_R2", type: "message", role: "assistant", model: "claude-3-opus", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "..." } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Round2" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 4 } })}\n\n`,
      messageStopSSE(),
    ];
    const adapter2 = new MessagesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...round2SSE)),
    });
    const result2 = await collectStream(adapter2.stream(makeRequest()));

    // 断言: 各轮内部 ID 符合预期格式
    expect(result1.output[0]!.type).toBe("reasoning");
    expect(result1.output[0]!.id).toBe("reason-0-msg_R1");
    expect(result1.output[1]!.type).toBe("message");
    expect(result1.output[1]!.id).toBe("msg-1-msg_R1");

    expect(result2.output[0]!.type).toBe("reasoning");
    expect(result2.output[0]!.id).toBe("reason-0-msg_R2");
    expect(result2.output[1]!.type).toBe("message");
    expect(result2.output[1]!.id).toBe("msg-1-msg_R2");

    // 核心断言: 相同索引的合成 ID 因 rawResponseId 不同而不同
    expect(result1.output[0]!.id).not.toBe(result2.output[0]!.id);
    expect(result1.output[1]!.id).not.toBe(result2.output[1]!.id);
  });

  it("should not namespace tool_use IDs (they use provider-generated IDs)", async () => {
    const sse1 = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_T1", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_A1", name: "get_weather", input: {} } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 5 } })}\n\n`,
      messageStopSSE(),
    ];
    const sse2 = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_T2", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_B2", name: "search", input: {} } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 5 } })}\n\n`,
      messageStopSSE(),
    ];

    const adapter1 = new MessagesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse1)),
    });
    const result1 = await collectStream(adapter1.stream(makeRequest()));

    const adapter2 = new MessagesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse2)),
    });
    const result2 = await collectStream(adapter2.stream(makeRequest()));

    // tool_use ID 直接来自 provider, 不做命名空间化
    expect(result1.output[0]!.type).toBe("tool_call");
    expect(result1.output[0]!.id).toBe("tu_A1");
    expect(result2.output[0]!.type).toBe("tool_call");
    expect(result2.output[0]!.id).toBe("tu_B2");
  });
});

// ── 错误处理 ──────────────────────────────────────────────────

describe("MessagesAdapter - error handling", () => {
  it("should emit warning on HTTP error", async () => {
    const errorResponse = new Response("Unauthorized", {
      status: 401,
      statusText: "Unauthorized",
    });

    const adapter = new MessagesAdapter({
      apiKey: "bad-key",
      fetch: async () => errorResponse,
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain("Messages API error 401");
    expect(result.output).toEqual([]);
  });

  it("should emit warning on SSE error event", async () => {
    const sse = [
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`,
      messageStopSSE(),
    ];

    const adapter = new MessagesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest()));
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes("Overloaded"))).toBe(true);
  });

  it("should emit warning for malformed SSE data", async () => {
    const sse = [
      `event: message_start\ndata: {bad json}\n\n`,
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_bad", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 1 } })}\n\n`,
      messageStopSSE(),
    ];

    const adapter = new MessagesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(adapter.stream(makeRequest({ include: { billing: "off" } })));
    expect(result.warnings?.some((w) => w.includes("malformed Messages SSE"))).toBe(true);
    expect(result.text).toBe("Hi");
  });
});

// ── 集成测试 ──────────────────────────────────────────────────

describe("MessagesAdapter - integration", () => {
  it("should produce events consumable via for-await-of", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_i", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 1 } })}\n\n`,
      messageStopSSE(),
    ];

    const adapter = new MessagesAdapter({
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

  it("should produce complete AIResponse with all fields", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_final", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thinking..." } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 5, output_tokens: 3 } })}\n\n`,
      messageStopSSE(),
    ];

    const adapter = new MessagesAdapter({
      apiKey: "test-key",
      fetch: mockFetch(sseResponse(...sse)),
    });

    const result = await collectStream(
      adapter.stream(
        makeRequest({
          requestId: "messages-integration",
        }),
      ),
    );

    expect(result.text).toBe("Done");
    expect(result.output).toHaveLength(2);
    expect(result.output[0]!.type).toBe("reasoning");
    expect(result.output[1]!.type).toBe("message");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage?.inputTokens).toBe(5);
    expect(result.usage?.outputTokens).toBe(3);
    expect(result.backend.adapter).toBe("messages");
    expect(result.backend.requestId).toBe("messages-integration");
    expect(result.replay).toBeDefined();
  });
});
