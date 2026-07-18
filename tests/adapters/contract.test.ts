import { describe, expect, it } from "bun:test";

import { ChatCompletionsAdapter, collectStream, GeminiAdapter, MessagesAdapter, MockAdapter, OllamaAdapter, ResponsesAdapter } from "../../src/index.js";

import { aggregateEvents } from "../../src/stream/aggregator.js";
import type { AIStreamEvent, FetchFn, NormalizedRequest } from "../../src/index.js";
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
      expect(result.warnings?.some((warning) => warning.includes("Billing information"))).toBeFalsy();
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
