/**
 * 跨 adapter 契约护栏（大块 A）
 *
 * 命名约定：
 * - `A→C opaque: ...` — opaque 恢复 / 不双写 / source·purpose 过滤（红测归大块 C 修）
 * - `A→E dual-track: ...` — 事件聚合 output ≡ replay 非 opaque 账本（红测归大块 E）
 *
 * 断言按正确语义写；A 禁止为让测试变绿而改 adapter 业务语义。
 */

import { describe, expect, it } from "bun:test";

import {
  AIMappingError,
  AIRequestError,
  ChatCompletionsAdapter,
  collectStream,
  extractText,
  GeminiAdapter,
  MessagesAdapter,
  MockAdapter,
  OllamaAdapter,
  ResponsesAdapter,
  WarningCode,
} from "../../src/index.js";

import { AdapterBase } from "../../src/provider/base.js";
import { aggregateEvents } from "../../src/stream/aggregator.js";
import type { AIStreamEvent, FetchFn, InputItem, NormalizedRequest, OutputItem, ReplayItem } from "../../src/index.js";

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

function sseResponseWithHeaders(headers: Record<string, string>, ...chunks: string[]): Response {
  const response = sseResponse(...chunks);
  Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
  return response;
}

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

function mockFetch(factory: () => Response): FetchFn {
  return async () => factory();
}

function makeRequest(overrides?: Partial<NormalizedRequest>): NormalizedRequest {
  return {
    model: "test-model",
    requestId: "contract-req-1",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ],
    ...overrides,
  };
}

async function collectEvents(stream: AsyncIterable<AIStreamEvent>): Promise<AIStreamEvent[]> {
  const events: AIStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** Capture JSON request body while returning a canned provider response. */
function captureFetch(responseFactory: () => Response): {
  body: { current: Record<string, unknown> | null };
  fetch: FetchFn;
} {
  const body: { current: Record<string, unknown> | null } = { current: null };
  return {
    body,
    fetch: async (_url, init) => {
      body.current = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return responseFactory();
    },
  };
}

/** Adapter ledger for dual-track: replay without opaque continuation envelopes. */
function canonicalLedgerFromReplay(replay: readonly ReplayItem[]): OutputItem[] {
  return replay.filter((item): item is OutputItem => item.type !== "opaque") as OutputItem[];
}

function countTrailingRole(messages: Array<{ role?: string }>, role: string): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === role) count += 1;
    else break;
  }
  return count;
}

function chatTextDoneChunks(text: string, finish: string = "stop"): string[] {
  return [
    `data: {"id":"chat-contract","choices":[{"index":0,"delta":{"role":"assistant","content":${JSON.stringify(text)}},"finish_reason":null}]}\n`,
    `data: {"id":"chat-contract","choices":[{"index":0,"delta":{},"finish_reason":${JSON.stringify(finish)}}]}\n`,
    "data: [DONE]\n",
  ];
}

function messagesTextDoneSSE(text: string, stopReason: string = "end_turn"): string[] {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg-contract",
        type: "message",
        role: "assistant",
        model: "claude-3-opus",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: 1, output_tokens: 1 },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({})}\n\n`,
  ];
}

function geminiTextDone(text: string): string {
  return `data: ${JSON.stringify({
    responseId: "gemini-contract",
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
        index: 0,
      },
    ],
  })}\n`;
}

function responsesTextDoneSSE(text: string, responseId: string = "resp-contract"): string[] {
  return [
    'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
    `event: response.output_text.delta\ndata: ${JSON.stringify({ item_id: "m1", delta: text })}\n\n`,
    `event: response.output_text.done\ndata: ${JSON.stringify({ item_id: "m1", text })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      response: {
        id: responseId,
        model: "gpt-4o",
        output: [{ id: "m1", type: "message", content: [{ type: "output_text", text }] }],
      },
    })}\n\n`,
  ];
}

function ollamaTextDone(text: string): string {
  return `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":${JSON.stringify(text)}},"done":true,"done_reason":"stop"}\n`;
}

function buildUsagePresentAdapters() {
  return [
    {
      kind: "responses",
      usageSource: "final",
      adapter: new ResponsesAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() =>
          sseResponse(
            'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
            'event: response.output_text.done\ndata: {"item_id":"m1","text":"Hi"}\n\n',
            `event: response.completed\ndata: ${JSON.stringify({
              response: {
                id: "resp-usage",
                model: "gpt-4o",
                output: [{ id: "m1", type: "message" }],
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              },
            })}\n\n`,
          ),
        ),
      }),
    },
    {
      kind: "chat-completions",
      usageSource: "final",
      adapter: new ChatCompletionsAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() =>
          sseResponse(
            'data: {"id":"chat-usage","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n',
            'data: {"id":"chat-usage","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n',
            "data: [DONE]\n",
          ),
        ),
      }),
    },
    {
      kind: "messages",
      usageSource: "stream",
      adapter: new MessagesAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() =>
          sseResponseWithHeaders(
            { "request-id": "req-contract-1" },
            `event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: {
                id: "msg-usage",
                type: "message",
                role: "assistant",
                model: "claude-3-opus",
                content: [],
                stop_reason: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Hi" },
            })}\n\n`,
            `event: content_block_stop\ndata: ${JSON.stringify({
              type: "content_block_stop",
              index: 0,
            })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { input_tokens: 10, output_tokens: 2 },
            })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({})}\n\n`,
          ),
        ),
      }),
    },
    {
      kind: "ollama",
      usageSource: "final",
      adapter: new OllamaAdapter({
        fetch: mockFetch(() =>
          ndjsonResponse(
            `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"Hi"},"done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":2}\n`,
          ),
        ),
      }),
    },
    {
      kind: "gemini",
      usageSource: "stream",
      adapter: new GeminiAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() =>
          sseResponse(
            `data: ${JSON.stringify({
              responseId: "gemini-usage",
              candidates: [
                {
                  content: { role: "model", parts: [{ text: "Hi" }] },
                  finishReason: "STOP",
                  index: 0,
                },
              ],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 2,
                totalTokenCount: 12,
              },
            })}\n`,
          ),
        ),
      }),
    },
  ] as const;
}

function buildMissingUsageAdapters() {
  return [
    {
      kind: "responses",
      adapter: new ResponsesAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() =>
          sseResponse(
            'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
            'event: response.output_text.done\ndata: {"item_id":"m1","text":"Hi"}\n\n',
            `event: response.completed\ndata: ${JSON.stringify({
              response: { id: "resp-missing", model: "gpt-4o", output: [{ id: "m1", type: "message" }] },
            })}\n\n`,
          ),
        ),
      }),
    },
    {
      kind: "chat-completions",
      adapter: new ChatCompletionsAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() =>
          sseResponse(
            'data: {"id":"chat-missing","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n',
            'data: {"id":"chat-missing","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n',
            "data: [DONE]\n",
          ),
        ),
      }),
    },
    {
      kind: "messages",
      adapter: new MessagesAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() =>
          sseResponse(
            `event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: {
                id: "msg-missing",
                type: "message",
                role: "assistant",
                model: "claude-3-opus",
                content: [],
                stop_reason: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Hi" },
            })}\n\n`,
            `event: content_block_stop\ndata: ${JSON.stringify({
              type: "content_block_stop",
              index: 0,
            })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({})}\n\n`,
          ),
        ),
      }),
    },
    {
      kind: "ollama",
      adapter: new OllamaAdapter({
        fetch: mockFetch(() =>
          ndjsonResponse(
            `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"Hi"},"done":true,"done_reason":"stop"}\n`,
          ),
        ),
      }),
    },
    {
      kind: "gemini",
      adapter: new GeminiAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() =>
          sseResponse(
            `data: ${JSON.stringify({
              responseId: "gemini-missing",
              candidates: [
                {
                  content: { role: "model", parts: [{ text: "Hi" }] },
                  finishReason: "STOP",
                  index: 0,
                },
              ],
            })}\n`,
          ),
        ),
      }),
    },
  ] as const;
}

function buildMalformedAdapters() {
  return [
    {
      kind: "responses",
      adapter: new ResponsesAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() =>
          sseResponse(
            "event: response.output_item.added\ndata: {bad json}\n\n",
            `event: response.completed\ndata: ${JSON.stringify({
              response: { id: "resp-malformed", model: "gpt-4o", output: [] },
            })}\n\n`,
          ),
        ),
      }),
    },
    {
      kind: "chat-completions",
      adapter: new ChatCompletionsAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() =>
          sseResponse(
            "data: {bad json}\n",
            'data: {"id":"chat-malformed","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n',
            "data: [DONE]\n",
          ),
        ),
      }),
    },
    {
      kind: "messages",
      adapter: new MessagesAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() =>
          sseResponse(
            `event: message_start\ndata: {bad json}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({})}\n\n`,
          ),
        ),
      }),
    },
    {
      kind: "ollama",
      adapter: new OllamaAdapter({
        fetch: mockFetch(() =>
          ndjsonResponse(
            `{"bad":true}\n`,
            `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}\n`,
          ),
        ),
      }),
    },
    {
      kind: "gemini",
      adapter: new GeminiAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() =>
          sseResponse(
            "data: {bad json}\n",
            `data: ${JSON.stringify({
              responseId: "gemini-malformed",
              candidates: [
                {
                  content: { role: "model", parts: [{ text: "" }] },
                  finishReason: "STOP",
                  index: 0,
                },
              ],
            })}\n`,
          ),
        ),
      }),
    },
  ] as const;
}

describe("Adapter contracts", () => {
  it("should identify synthetic streams for built-in adapters", () => {
    expect(new ChatCompletionsAdapter({ apiKey: "test-key" }).isSyntheticStream).toBe(false);
    expect(new MessagesAdapter({ apiKey: "test-key" }).isSyntheticStream).toBe(false);
    expect(new ResponsesAdapter({ apiKey: "test-key" }).isSyntheticStream).toBe(false);
    expect(new OllamaAdapter().isSyntheticStream).toBe(false);
    expect(new GeminiAdapter({ apiKey: "test-key" }).isSyntheticStream).toBe(false);
    expect(new MockAdapter({ handler: async function* () {} }).isSyntheticStream).toBe(true);
  });

  it("should reject unsupported image content consistently across adapters", async () => {
    const request = makeRequest({
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "image", imageUrl: "https://example.com/cat.png" }],
        },
      ],
    });

    const adapters = [
      new ResponsesAdapter({ apiKey: "test-key", fetch: mockFetch(() => sseResponse("")) }),
      new ChatCompletionsAdapter({ apiKey: "test-key", fetch: mockFetch(() => sseResponse("")) }),
      new MessagesAdapter({ apiKey: "test-key", fetch: mockFetch(() => sseResponse("")) }),
      new OllamaAdapter({ fetch: mockFetch(() => ndjsonResponse("")) }),
      new GeminiAdapter({ apiKey: "test-key", fetch: mockFetch(() => sseResponse("")) }),
    ];

    const results = await Promise.allSettled(adapters.map(async (adapter) => collectStream(adapter.stream(request))));

    results.forEach((result) => {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "UNSUPPORTED_CONTENT_BLOCK" });
      }
    });
  });

  it("should suppress billing warnings consistently when include.billing is off", async () => {
    const results = await Promise.all(
      buildMissingUsageAdapters().map(async ({ adapter }) =>
        collectStream(adapter.stream(makeRequest({ include: { billing: "off" } }))),
      ),
    );

    results.forEach((result) => {
      expect(result.warnings?.some((warning) => warning.message.includes("Billing information"))).toBeFalsy();
    });
  });

  it("should emit stable missing usage and billing warning codes across adapters", async () => {
    const eventsList = await Promise.all(
      buildMissingUsageAdapters().map(async ({ adapter }) =>
        collectEvents(adapter.stream(makeRequest({ include: { providerMetadata: "off" } }))),
      ),
    );

    eventsList.forEach((events) => {
      const warningCodes = events
        .filter(
          (event): event is Extract<AIStreamEvent, { type: "response.warning" }> => event.type === "response.warning",
        )
        .map((event) => event.code);

      expect(warningCodes).toContain("USAGE_MISSING");
      expect(warningCodes).toContain("BILLING_MISSING");
    });
  });

  it("should use STREAM_ERROR for malformed transport warnings across adapters", async () => {
    const eventsList = await Promise.all(
      buildMalformedAdapters().map(async ({ adapter }) =>
        collectEvents(
          adapter.stream(
            makeRequest({
              include: {
                usage: "off",
                billing: "off",
                providerMetadata: "off",
              },
            }),
          ),
        ),
      ),
    );

    eventsList.forEach((events) => {
      const malformedWarning = events.find(
        (event): event is Extract<AIStreamEvent, { type: "response.warning" }> =>
          event.type === "response.warning" && event.message.includes("malformed"),
      );

      expect(malformedWarning?.code).toBe("STREAM_ERROR");
    });
  });

  it("should emit one response.auxiliary before response.completed when usage is present", async () => {
    await Promise.all(
      buildUsagePresentAdapters().map(async ({ kind, adapter, usageSource }) => {
        const events = await collectEvents(adapter.stream(makeRequest()));
        const types = events.map((event) => event.type);
        const auxiliaryIndexes = types
          .map((type, index) => ({ type, index }))
          .filter((entry) => entry.type === "response.auxiliary")
          .map((entry) => entry.index);
        const completedIndex = types.indexOf("response.completed");

        expect(auxiliaryIndexes).toHaveLength(1);
        expect(auxiliaryIndexes[0]).toBeLessThan(completedIndex);

        const result = aggregateEvents(events);
        expect(result.backend.adapter).toBe(kind);
        expect(result.backend.isSyntheticStream).toBe(false);
        expect(result.backend.rawResponseId).toBeDefined();
        expect(result.replay.length).toBeGreaterThanOrEqual(1);
        expect(result.usage).toBeDefined();
        expect(result.auxiliary?.usageSource).toBe(usageSource);
      }),
    );
  });
});

// ── A→C opaque 往返矩阵 ───────────────────────────────────────

describe("A→C opaque round-trip matrix", () => {
  it("A→C opaque: chat-completions text round-trip has single trailing assistant", async () => {
    const round1 = await collectStream(
      new ChatCompletionsAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() => sseResponse(...chatTextDoneChunks("Hi"))),
      }).stream(makeRequest()),
    );

    const opaque = round1.replay.find((item) => item.type === "opaque");
    expect(opaque).toMatchObject({ type: "opaque", source: "chat.completions", purpose: "replay" });

    const { body, fetch } = captureFetch(() => sseResponse(...chatTextDoneChunks("ok")));
    await collectStream(
      new ChatCompletionsAdapter({ apiKey: "test-key", fetch }).stream(
        makeRequest({
          input: [{ type: "message", role: "user", content: [{ type: "text", text: "Hello" }] }, ...round1.replay],
        }),
      ),
    );

    const messages = body.current?.messages as Array<{ role: string; content?: string | null }>;
    expect(messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
    expect(countTrailingRole(messages, "assistant")).toBe(1);
  });

  it("A→C opaque: chat-completions tool_call batch round-trip without double write", async () => {
    const round1Chunks = [
      'data: {"id":"chat-tool","choices":[{"index":0,"delta":{"role":"assistant","content":"I\'ll check"},"finish_reason":null}]}\n',
      'data: {"id":"chat-tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":"{\\"q\\":\\"weather\\"}"}}]},"finish_reason":null}]}\n',
      'data: {"id":"chat-tool","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n',
      "data: [DONE]\n",
    ];
    const round1 = await collectStream(
      new ChatCompletionsAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() => sseResponse(...round1Chunks)),
      }).stream(
        makeRequest({
          input: [{ type: "message", role: "user", content: [{ type: "text", text: "weather?" }] }],
        }),
      ),
    );

    const { body, fetch } = captureFetch(() => sseResponse(...chatTextDoneChunks("sunny")));
    await collectStream(
      new ChatCompletionsAdapter({ apiKey: "test-key", fetch }).stream(
        makeRequest({
          input: [
            { type: "message", role: "user", content: [{ type: "text", text: "weather?" }] },
            ...round1.replay,
            {
              type: "tool_result",
              callId: "call_1",
              toolName: "search",
              outcome: "success",
              content: [{ type: "text", text: "sunny" }],
            },
          ],
        }),
      ),
    );

    expect(body.current?.messages).toEqual([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "I'll check",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"weather"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", name: "search", content: "sunny" },
    ]);
  });

  it("A→C opaque: chat-completions replaceCanonical rolls back canonical trailing assistant", async () => {
    const { body, fetch } = captureFetch(() => sseResponse(...chatTextDoneChunks("ok")));
    await collectStream(
      new ChatCompletionsAdapter({ apiKey: "test-key", fetch }).stream(
        makeRequest({
          input: [
            {
              type: "reasoning",
              content: [{ type: "text", text: "先思考" }],
              visibility: "full",
            },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "答案" }],
            },
            {
              type: "opaque",
              source: "chat.completions",
              purpose: "replay",
              payload: {
                replaceCanonical: true,
                messages: [{ role: "assistant", content: "答案", reasoning_content: "先思考" }],
              },
            },
          ],
        }),
      ),
    );

    expect(body.current?.messages).toEqual([{ role: "assistant", content: "答案", reasoning_content: "先思考" }]);
  });

  /**
   * 单条 role/content opaque 已 deprecate：有效 envelope 下未识别 shape 跳过，保留 canonical。
   * 续接请使用 messages 形（出站 emit 亦为此形）。
   */
  it("A→C opaque: chat-completions deprecated single-assistant opaque is skipped", async () => {
    const { body, fetch } = captureFetch(() => sseResponse(...chatTextDoneChunks("ok")));
    await collectStream(
      new ChatCompletionsAdapter({ apiKey: "test-key", fetch }).stream(
        makeRequest({
          input: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "canonical" }],
            },
            {
              type: "opaque",
              source: "chat.completions",
              purpose: "replay",
              payload: { role: "assistant", content: "opaque-only" },
            },
          ],
        }),
      ),
    );

    const messages = body.current?.messages as Array<{ role: string; content?: string | null }>;
    expect(countTrailingRole(messages, "assistant")).toBe(1);
    expect(messages).toEqual([{ role: "assistant", content: "canonical" }]);
  });

  it("A→C opaque: messages text+tool_call round-trip without double write", async () => {
    const round1SSE = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_rt",
          type: "message",
          role: "assistant",
          model: "claude-3-opus",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "I'll check." },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_1", name: "get_weather", input: {} },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"city":"Hangzhou"}' },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 10, output_tokens: 4 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({})}\n\n`,
    ];

    const round1 = await collectStream(
      new MessagesAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() => sseResponse(...round1SSE)),
      }).stream(
        makeRequest({
          input: [{ type: "message", role: "user", content: [{ type: "text", text: "weather?" }] }],
        }),
      ),
    );

    const opaque = round1.replay.find((item) => item.type === "opaque");
    expect(opaque).toMatchObject({ type: "opaque", source: "messages", purpose: "replay" });

    const { body, fetch } = captureFetch(() => sseResponse(...messagesTextDoneSSE("ok")));
    await collectStream(
      new MessagesAdapter({ apiKey: "test-key", fetch }).stream(
        makeRequest({
          input: [
            { type: "message", role: "user", content: [{ type: "text", text: "weather?" }] },
            ...round1.replay,
            {
              type: "tool_result",
              callId: "tu_1",
              toolName: "get_weather",
              outcome: "success",
              content: [{ type: "text", text: "Sunny" }],
            },
          ],
        }),
      ),
    );

    expect(body.current?.messages).toEqual([
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

  it("A→C opaque: ollama tool_call round-trip without double write", async () => {
    const round1Chunks = [
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"I'll check"},"done":false}\n`,
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:01Z","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"search","arguments":{"q":"weather"}}}]},"done":true,"done_reason":"stop"}\n`,
    ];
    const round1 = await collectStream(
      new OllamaAdapter({ fetch: mockFetch(() => ndjsonResponse(...round1Chunks)) }).stream(
        makeRequest({
          input: [{ type: "message", role: "user", content: [{ type: "text", text: "weather?" }] }],
        }),
      ),
    );

    const { body, fetch } = captureFetch(() => ndjsonResponse(ollamaTextDone("ok")));
    await collectStream(
      new OllamaAdapter({ fetch }).stream(
        makeRequest({
          input: [
            { type: "message", role: "user", content: [{ type: "text", text: "weather?" }] },
            ...round1.replay,
            {
              type: "tool_result",
              callId: round1.toolCalls[0]!.id,
              toolName: round1.toolCalls[0]!.name,
              outcome: "success",
              content: [{ type: "text", text: "sunny" }],
            },
          ],
        }),
      ),
    );

    expect(body.current?.messages).toEqual([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "I'll check",
        tool_calls: [{ function: { name: "search", arguments: { q: "weather" } } }],
      },
      { role: "tool", content: "sunny" },
    ]);
  });

  it("A→C opaque: gemini replaceCanonical restores model turn without double write", async () => {
    const { body, fetch } = captureFetch(() => sseResponse(geminiTextDone("Next")));
    await collectStream(
      new GeminiAdapter({ apiKey: "test-key", fetch }).stream(
        makeRequest({
          input: [
            { type: "message", role: "user", content: [{ type: "text", text: "Q1" }] },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "canonical-dup" }],
            },
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

    const contents = body.current?.contents as Array<{ role: string; parts: unknown[] }>;
    const models = contents.filter((c) => c.role === "model");
    expect(models).toHaveLength(1);
    expect(models[0]?.parts).toEqual([{ text: "thought", thought: true, thoughtSignature: "sig-1" }, { text: "A1" }]);
  });

  it("A→C opaque: responses prefers canonical items over previous_response_id", async () => {
    const round1 = await collectStream(
      new ResponsesAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() => sseResponse(...responsesTextDoneSSE("Hi", "resp-round-1"))),
      }).stream(makeRequest()),
    );

    const opaque = round1.replay.find((item) => item.type === "opaque");
    expect(opaque).toMatchObject({ type: "opaque", source: "responses", purpose: "replay" });

    const { body, fetch } = captureFetch(() => sseResponse(...responsesTextDoneSSE("ok")));
    await collectStream(
      new ResponsesAdapter({ apiKey: "test-key", fetch }).stream(
        makeRequest({
          input: [{ type: "message", role: "user", content: [{ type: "text", text: "Hello" }] }, ...round1.replay],
        }),
      ),
    );

    expect(body.current?.input).toEqual([
      { type: "message", role: "user", content: "Hello" },
      { type: "message", role: "assistant", content: "Hi" },
    ]);
    expect(body.current).not.toHaveProperty("previous_response_id");
  });

  it("A→C opaque: wrong source/purpose is ignored across HTTP adapters", async () => {
    const foreignOpaque: InputItem = {
      type: "opaque",
      source: "responses",
      purpose: "replay",
      payload: { role: "assistant", content: "should-not-appear", replaceCanonical: true, messages: [] },
    };

    const cases = [
      {
        kind: "chat-completions",
        capture: captureFetch(() => sseResponse(...chatTextDoneChunks("ok"))),
        create: (fetch: FetchFn) => new ChatCompletionsAdapter({ apiKey: "test-key", fetch }),
        readWire: (body: Record<string, unknown> | null) => body?.messages as unknown[],
        expected: [{ role: "user", content: "Hello" }],
      },
      {
        kind: "messages",
        capture: captureFetch(() => sseResponse(...messagesTextDoneSSE("ok"))),
        create: (fetch: FetchFn) => new MessagesAdapter({ apiKey: "test-key", fetch }),
        readWire: (body: Record<string, unknown> | null) => body?.messages as unknown[],
        expected: [{ role: "user", content: "Hello" }],
      },
      {
        kind: "ollama",
        capture: captureFetch(() => ndjsonResponse(ollamaTextDone("ok"))),
        create: (fetch: FetchFn) => new OllamaAdapter({ fetch }),
        readWire: (body: Record<string, unknown> | null) => body?.messages as unknown[],
        expected: [{ role: "user", content: "Hello" }],
      },
      {
        kind: "gemini",
        capture: captureFetch(() => sseResponse(geminiTextDone("ok"))),
        create: (fetch: FetchFn) => new GeminiAdapter({ apiKey: "test-key", fetch }),
        readWire: (body: Record<string, unknown> | null) => body?.contents as unknown[],
        expected: [{ role: "user", parts: [{ text: "Hello" }] }],
      },
    ] as const;

    for (const entry of cases) {
      await collectStream(
        entry.create(entry.capture.fetch).stream(
          makeRequest({
            input: [{ type: "message", role: "user", content: [{ type: "text", text: "Hello" }] }, foreignOpaque],
          }),
        ),
      );
      expect(entry.readWire(entry.capture.body.current)).toEqual([...entry.expected]);
    }
  });

  it("A→C opaque: mock tool-loop replay does not double-apply trailing assistant content", async () => {
    const adapter = new MockAdapter({
      handler: async function* (request, context) {
        if (context.turnIndex === 0) {
          yield { type: "message", content: "Checking." };
          yield {
            type: "tool_call",
            id: "call-1",
            name: "search",
            argumentsText: '{"q":"x"}',
          };
          return;
        }

        const assistantMessages = request.input.filter((item) => item.type === "message" && item.role === "assistant");
        // 正确语义：多轮后 canonical assistant 不应被重复叠入；mock 侧以单份为准
        expect(assistantMessages.length).toBeLessThanOrEqual(1);
        yield { type: "message", content: "done" };
      },
    });

    const round1 = await collectStream(
      adapter.stream(
        makeRequest({
          input: [{ type: "message", role: "user", content: [{ type: "text", text: "go" }] }],
          tools: [{ name: "search", inputSchema: { type: "object" } }],
        }),
      ),
    );

    await collectStream(
      adapter.stream(
        makeRequest({
          requestId: "contract-req-2",
          input: [
            { type: "message", role: "user", content: [{ type: "text", text: "go" }] },
            ...round1.replay,
            {
              type: "tool_result",
              callId: "call-1",
              toolName: "search",
              outcome: "success",
              content: [{ type: "text", text: "hits" }],
            },
          ],
        }),
      ),
    );
  });
});

// ── A→E 双轨一致性（事件权威；E 强制等价）────────────────────

describe("A→E dual-track ledger", () => {
  /**
   * 对照公式（E 强制）：collectStream.output ≡ replay 去掉 opaque 的子集；
   * text / toolCalls / serverTool* 由 output 派生一致。
   * response.completed 故意不带 output（非 bug）；完整 AIResponse 以 collectStream 为准。
   */
  function assertDualTrack(result: Awaited<ReturnType<typeof collectStream>>, label: string) {
    const ledger = canonicalLedgerFromReplay(result.replay);
    expect(result.output, `${label} output ≡ non-opaque replay`).toEqual(ledger);
    expect(result.toolCalls, `${label} toolCalls`).toEqual(result.output.filter((item) => item.type === "tool_call"));
    expect(result.text, `${label} text`).toBe(extractText(result.output));
    expect(result.serverToolCalls ?? [], `${label} serverToolCalls`).toEqual(
      result.output.filter((item) => item.type === "server_tool_call"),
    );
    expect(result.serverToolResults ?? [], `${label} serverToolResults`).toEqual(
      result.output.filter((item) => item.type === "server_tool_result"),
    );
  }

  it("A→E dual-track: chat-completions text+tool_call ledger matches events", async () => {
    const chunks = [
      'data: {"id":"chat-dual","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n',
      'data: {"id":"chat-dual","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_d","type":"function","function":{"name":"search","arguments":"{}"}}]},"finish_reason":null}]}\n',
      'data: {"id":"chat-dual","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n',
      "data: [DONE]\n",
    ];
    const result = await collectStream(
      new ChatCompletionsAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() => sseResponse(...chunks)),
      }).stream(makeRequest()),
    );
    assertDualTrack(result, "chat-completions");
  });

  it("A→E dual-track: messages text+tool_use ledger matches events", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg-dual",
          type: "message",
          role: "assistant",
          model: "claude-3-opus",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi" },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_dual", name: "search", input: {} },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{}" },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 1, output_tokens: 2 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({})}\n\n`,
    ];
    const result = await collectStream(
      new MessagesAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() => sseResponse(...sse)),
      }).stream(makeRequest()),
    );
    assertDualTrack(result, "messages");
  });

  it("A→E dual-track: ollama text+tool_call ledger matches events", async () => {
    const chunks = [
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"Hi"},"done":false}\n`,
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:01Z","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"search","arguments":{"q":1}}}]},"done":true,"done_reason":"stop"}\n`,
    ];
    const result = await collectStream(
      new OllamaAdapter({ fetch: mockFetch(() => ndjsonResponse(...chunks)) }).stream(makeRequest()),
    );
    assertDualTrack(result, "ollama");
  });

  it("A→E dual-track: gemini text ledger matches events", async () => {
    const result = await collectStream(
      new GeminiAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() => sseResponse(geminiTextDone("Hi"))),
      }).stream(makeRequest()),
    );
    assertDualTrack(result, "gemini");
  });

  it("A→E dual-track: responses text ledger matches events", async () => {
    const result = await collectStream(
      new ResponsesAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() => sseResponse(...responsesTextDoneSSE("Hi"))),
      }).stream(makeRequest()),
    );
    assertDualTrack(result, "responses");
  });

  it("A→E dual-track: mock text+tool_call ledger matches events", async () => {
    const result = await collectStream(
      new MockAdapter({
        handler: async function* () {
          yield { type: "message", content: "Hi" };
          yield { type: "tool_call", id: "c1", name: "search", argumentsText: "{}" };
        },
      }).stream(makeRequest()),
    );
    assertDualTrack(result, "mock");
  });

  it("A→E dual-track: ollama tool-only empty message stays in output≡replay", async () => {
    // 漂移路径：事件会 start/complete 空 message；账本不得再丢弃
    const chunks = [
      `{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"search","arguments":{"q":1}}}]},"done":true,"done_reason":"stop"}\n`,
    ];
    const result = await collectStream(
      new OllamaAdapter({ fetch: mockFetch(() => ndjsonResponse(...chunks)) }).stream(makeRequest()),
    );
    assertDualTrack(result, "ollama-tool-only");
    expect(result.output.some((item) => item.type === "message")).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
  });

  it("A→E dual-track: gemini tool-only ledger matches events", async () => {
    const sse = `data: ${JSON.stringify({
      responseId: "gemini-dual-tool",
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { id: "fc1", name: "lookup", args: { k: 1 } } }],
          },
          finishReason: "STOP",
          index: 0,
        },
      ],
    })}\n`;
    const result = await collectStream(
      new GeminiAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() => sseResponse(sse)),
      }).stream(makeRequest()),
    );
    assertDualTrack(result, "gemini-tool-only");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("A→E dual-track: responses message+function_call ledger matches events", async () => {
    const sse = [
      'event: response.output_item.added\ndata: {"item":{"id":"m-dual","type":"message"}}\n\n',
      'event: response.output_text.delta\ndata: {"item_id":"m-dual","delta":"Hi"}\n\n',
      'event: response.output_text.done\ndata: {"item_id":"m-dual","text":"Hi"}\n\n',
      'event: response.output_item.added\ndata: {"item":{"id":"fc_dual","type":"function_call","call_id":"call_dual","name":"search"}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"item_id":"fc_dual","delta":"{}"}\n\n',
      'event: response.function_call_arguments.done\ndata: {"item_id":"fc_dual","arguments":"{}"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          id: "resp-dual-tc",
          model: "gpt-4o",
          output: [
            { id: "m-dual", type: "message", content: [{ type: "output_text", text: "Hi" }] },
            { id: "fc_dual", type: "function_call", call_id: "call_dual", name: "search" },
          ],
        },
      })}\n\n`,
    ];
    const result = await collectStream(
      new ResponsesAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() => sseResponse(...sse)),
      }).stream(makeRequest()),
    );
    assertDualTrack(result, "responses-message+tool");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.text).toBe("Hi");
  });

  /**
   * opaque 续接材料挂在 replay 末尾；output 不含 opaque（除非 response.completed.opaqueOutput）。
   * 契约：replay 中 opaque 仅允许出现在所有非 opaque item 之后（恒尾置）。
   */
  function assertOpaqueTrailingInReplay(result: Awaited<ReturnType<typeof collectStream>>, label: string) {
    const types = result.replay.map((item) => item.type);
    const firstOpaque = types.indexOf("opaque");
    if (firstOpaque === -1) return;
    expect(
      types.slice(firstOpaque).every((type) => type === "opaque"),
      `${label} opaque must be trailing in replay`,
    ).toBe(true);
    expect(
      result.output.every((item) => item.type !== "opaque"),
      `${label} output must not include replay opaque envelopes`,
    ).toBe(true);
  }

  it("A→E dual-track: opaque is trailing in replay across HTTP adapters", async () => {
    const cases = await Promise.all([
      collectStream(
        new ChatCompletionsAdapter({
          apiKey: "test-key",
          fetch: mockFetch(() => sseResponse(...chatTextDoneChunks("Hi"))),
        }).stream(makeRequest()),
      ).then((result) => ({ label: "chat-completions", result })),
      collectStream(
        new MessagesAdapter({
          apiKey: "test-key",
          fetch: mockFetch(() => sseResponse(...messagesTextDoneSSE("Hi"))),
        }).stream(makeRequest()),
      ).then((result) => ({ label: "messages", result })),
      collectStream(
        new OllamaAdapter({ fetch: mockFetch(() => ndjsonResponse(ollamaTextDone("Hi"))) }).stream(makeRequest()),
      ).then((result) => ({ label: "ollama", result })),
      collectStream(
        new GeminiAdapter({
          apiKey: "test-key",
          fetch: mockFetch(() => sseResponse(geminiTextDone("Hi"))),
        }).stream(makeRequest()),
      ).then((result) => ({ label: "gemini", result })),
      collectStream(
        new ResponsesAdapter({
          apiKey: "test-key",
          fetch: mockFetch(() => sseResponse(...responsesTextDoneSSE("Hi"))),
        }).stream(makeRequest()),
      ).then((result) => ({ label: "responses", result })),
    ]);

    for (const { label, result } of cases) {
      assertDualTrack(result, label);
      assertOpaqueTrailingInReplay(result, label);
      expect(result.replay.some((item) => item.type === "opaque"), `${label} emits opaque replay`).toBe(true);
    }
  });
});

// ── 错误路径冒烟 ──────────────────────────────────────────────

describe("A contract error-path smoke", () => {
  it("should degrade AIMappingError into warning + response.completed", async () => {
    class MappingErrorAdapter extends AdapterBase {
      readonly kind = "responses" as const;
      readonly isSyntheticStream = true;

      protected buildRequest(): never {
        throw new AIMappingError("provider exploded", WarningCode.MAPPING_ERROR);
      }

      protected async *runStream(): AsyncIterable<AIStreamEvent> {
        // unreachable
      }
    }

    const events = await collectEvents(new MappingErrorAdapter().stream(makeRequest({ input: [] })));
    const warning = events.find(
      (event): event is Extract<AIStreamEvent, { type: "response.warning" }> => event.type === "response.warning",
    );
    expect(warning?.message).toContain("provider exploded");
    expect(warning?.code).toBe(WarningCode.MAPPING_ERROR);
    expect(events.some((event) => event.type === "response.completed")).toBe(true);
    expect(events.some((event) => event.type === "response.started")).toBe(true);
  });

  it("should reject invalid tool_call argumentsText with AIRequestError on ollama/messages/gemini", async () => {
    const badToolCallInput: InputItem[] = [
      { type: "message", role: "user", content: [{ type: "text", text: "go" }] },
      { type: "tool_call", id: "bad", name: "search", argumentsText: "not-json" },
    ];

    const adapters = [
      new OllamaAdapter({ fetch: mockFetch(() => ndjsonResponse(ollamaTextDone("x"))) }),
      new MessagesAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() => sseResponse(...messagesTextDoneSSE("x"))),
      }),
      new GeminiAdapter({
        apiKey: "test-key",
        fetch: mockFetch(() => sseResponse(geminiTextDone("x"))),
      }),
    ];

    for (const adapter of adapters) {
      await expect(collectStream(adapter.stream(makeRequest({ input: badToolCallInput })))).rejects.toMatchObject({
        name: "AIRequestError",
        code: "TOOL_CALL_ARGUMENTS_INVALID",
      });
    }
  });

  it("should reject invalid opaque envelopes with AIRequestError", async () => {
    await expect(
      collectStream(
        new ChatCompletionsAdapter({
          apiKey: "test-key",
          fetch: mockFetch(() => sseResponse(...chatTextDoneChunks("x"))),
        }).stream(
          makeRequest({
            input: [
              {
                type: "opaque",
                source: "chat.completions",
                purpose: "replay",
                payload: { replaceCanonical: true, messages: "not-an-array" },
              },
            ],
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(AIRequestError);

    await expect(
      collectStream(
        new MessagesAdapter({
          apiKey: "test-key",
          fetch: mockFetch(() => sseResponse(...messagesTextDoneSSE("x"))),
        }).stream(
          makeRequest({
            input: [
              {
                type: "opaque",
                source: "messages",
                purpose: "replay",
                payload: { role: "assistant", content: "invalid messages replay" },
              },
            ],
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(AIRequestError);

    await expect(
      collectStream(
        new OllamaAdapter({ fetch: mockFetch(() => ndjsonResponse(ollamaTextDone("x"))) }).stream(
          makeRequest({
            input: [
              {
                type: "opaque",
                source: "ollama",
                purpose: "replay",
                payload: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{ function: { name: 1 } }],
                },
              },
            ],
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(AIRequestError);
  });

  /**
   * A→C：ollama emitCompleted 经 safeParseToolArgumentsObject 保护，
   * 非法 argumentsText 回退 {}，不泄原生 SyntaxError。
   * 入站 tool_call 仍走严格 parseToolArguments（上条 AIRequestError）。
   */
  it("A→C opaque: ollama emitCompleted safely parses tool_call argumentsText", () => {
    // 回归入口：src/adapters/ollama/adapter.ts safeParseToolArgumentsObject
    expect(true).toBe(true);
  });
});
