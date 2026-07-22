/**
 * 上下文压缩能力：type guard + Responses compact + Mock 夹具
 */

import { describe, it, expect } from "bun:test";
import {
  AIProviderError,
  AIRequestError,
  ChatCompletionsAdapter,
  MockAdapter,
  ResponsesAdapter,
  collectStream,
  supportsContextCompress,
} from "../../src/index.js";
import { buildResponsesCompactRequest, buildResponsesRequest } from "../../src/adapters/responses/map-request.js";
import type { CompressRequest, FetchFn, InputItem, NormalizedRequest } from "../../src/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

const sampleTranscript: InputItem[] = [
  { type: "message", role: "user", content: [{ type: "text", text: "Hello" }] },
  { type: "message", role: "assistant", content: [{ type: "text", text: "Hi there" }] },
  { type: "message", role: "user", content: [{ type: "text", text: "Continue" }] },
];

const compactOutput = [
  {
    id: "msg_000",
    type: "message",
    status: "completed",
    role: "user",
    content: [{ type: "input_text", text: "Hello" }],
  },
  {
    id: "cmp_001",
    type: "compaction",
    encrypted_content: "gAAAAABpM0Yj-test",
  },
];

describe("supportsContextCompress", () => {
  it("is true for ResponsesAdapter and MockAdapter", () => {
    expect(supportsContextCompress(new ResponsesAdapter({ apiKey: "k", fetch: async () => jsonResponse({}) }))).toBe(
      true,
    );
    expect(
      supportsContextCompress(
        new MockAdapter({
          handler: async function* () {
            yield { type: "message", content: "ok" };
          },
        }),
      ),
    ).toBe(true);
  });

  it("is false for adapters without compress", () => {
    expect(
      supportsContextCompress(new ChatCompletionsAdapter({ apiKey: "k", fetch: async () => sseResponse("") })),
    ).toBe(false);
  });
});

describe("buildResponsesCompactRequest", () => {
  it("maps model/input/instructions without stream or tools", () => {
    const body = buildResponsesCompactRequest({
      model: "gpt-5.1",
      input: sampleTranscript,
      instructions: "Be brief",
    });
    expect(body.model).toBe("gpt-5.1");
    expect(body.instructions).toBe("Be brief");
    expect(body).not.toHaveProperty("stream");
    expect(body).not.toHaveProperty("tools");
    expect(body.input).toEqual([
      { type: "message", role: "user", content: "Hello" },
      { type: "message", role: "assistant", content: "Hi there" },
      { type: "message", role: "user", content: "Continue" },
    ]);
  });

  it("rejects empty input", () => {
    expect(() => buildResponsesCompactRequest({ model: "gpt-5.1", input: [] })).toThrow(AIRequestError);
  });
});

describe("compacted_window opaque inbound", () => {
  it("expands compacted_window into wire input and ignores previous_response_id", () => {
    const request: NormalizedRequest = {
      model: "gpt-4o",
      requestId: "r1",
      input: [
        {
          type: "opaque",
          source: "responses",
          purpose: "replay",
          payload: {
            kind: "compacted_window",
            id: "resp_compact_1",
            output: compactOutput,
          },
        },
        {
          type: "opaque",
          source: "responses",
          purpose: "replay",
          payload: { previous_response_id: "resp-should-ignore" },
        },
        { type: "message", role: "user", content: [{ type: "text", text: "Next turn" }] },
      ],
    };

    const body = buildResponsesRequest(request);
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body.input).toEqual([...compactOutput, { type: "message", role: "user", content: "Next turn" }]);
  });

  it("throws when compacted_window.output is missing", () => {
    try {
      buildResponsesRequest({
        model: "gpt-4o",
        requestId: "r1",
        input: [
          {
            type: "opaque",
            source: "responses",
            purpose: "replay",
            payload: { kind: "compacted_window" },
          },
        ],
      });
      throw new Error("expected INVALID_OPAQUE_REPLAY");
    } catch (err) {
      expect(err).toMatchObject({ name: "AIRequestError", code: "INVALID_OPAQUE_REPLAY" });
    }
  });
});

describe("ResponsesAdapter.compress", () => {
  it("POSTs /responses/compact and returns single opaque replay", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;
    let capturedAuth = "";

    const fetch: FetchFn = async (url, init) => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({
        id: "resp_001",
        object: "response.compaction",
        created_at: 1764967971,
        output: compactOutput,
        usage: {
          input_tokens: 139,
          output_tokens: 438,
          total_tokens: 577,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 64 },
        },
      });
    };

    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });
    const result = await adapter.compress({
      model: "gpt-5.1",
      input: sampleTranscript,
      include: { usage: "best_effort" },
    });

    expect(capturedUrl).toBe("https://api.openai.com/v1/responses/compact");
    expect(capturedAuth).toBe("Bearer test-key");
    expect(capturedBody?.model).toBe("gpt-5.1");
    expect(capturedBody).not.toHaveProperty("stream");
    expect(result.rawResponseId).toBe("resp_001");
    expect(result.usage?.inputTokens).toBe(139);
    expect(result.usage?.reasoningTokens).toBe(64);
    expect(result.auxiliary?.providerUsage).toBeDefined();
    expect(result.replay).toHaveLength(1);
    expect(result.replay[0]).toMatchObject({
      type: "opaque",
      source: "responses",
      purpose: "replay",
      payload: {
        kind: "compacted_window",
        id: "resp_001",
        output: compactOutput,
      },
    });
  });

  it("round-trips compact replay into next stream request input", async () => {
    let streamBody: Record<string, unknown> | undefined;
    let call = 0;

    const fetch: FetchFn = async (url, init) => {
      call += 1;
      if (String(url).endsWith("/responses/compact")) {
        return jsonResponse({
          id: "resp_cmp",
          object: "response.compaction",
          output: compactOutput,
        });
      }
      streamBody = JSON.parse(String(init?.body));
      return sseResponse(
        'event: response.output_item.added\ndata: {"item":{"id":"m1","type":"message"}}\n\n',
        'event: response.output_text.done\ndata: {"item_id":"m1","text":"ok"}\n\n',
        `event: response.completed\ndata: ${JSON.stringify({
          response: { id: "resp-next", model: "gpt-4o", output: [{ id: "m1", type: "message" }] },
        })}\n\n`,
      );
    };

    const adapter = new ResponsesAdapter({ apiKey: "test-key", fetch });
    const { replay } = await adapter.compress({ model: "gpt-4o", input: sampleTranscript });
    const transcript: InputItem[] = [
      ...replay,
      { type: "message", role: "user", content: [{ type: "text", text: "What next?" }] },
    ];

    const result = await collectStream(
      adapter.stream({
        model: "gpt-4o",
        requestId: "next-1",
        input: transcript,
      }),
    );

    expect(call).toBe(2);
    expect(result.text).toBe("ok");
    expect(streamBody?.input).toEqual([...compactOutput, { type: "message", role: "user", content: "What next?" }]);
    expect(streamBody).not.toHaveProperty("previous_response_id");
  });

  it("maps HTTP errors via provider path", async () => {
    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: async () => new Response("nope", { status: 401 }),
    });
    await expect(adapter.compress({ model: "gpt-4o", input: sampleTranscript })).rejects.toBeInstanceOf(
      AIProviderError,
    );
  });

  it("propagates abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new ResponsesAdapter({
      apiKey: "test-key",
      fetch: async () => jsonResponse({ output: [] }),
    });
    await expect(
      adapter.compress({ model: "gpt-4o", input: sampleTranscript, signal: controller.signal }),
    ).rejects.toBeDefined();
  });
});

describe("MockAdapter.compress", () => {
  it("throws when compressHandler is missing", async () => {
    const adapter = new MockAdapter({
      handler: async function* () {
        yield { type: "message", content: "x" };
      },
    });
    await expect(
      adapter.compress({ model: "mock", input: sampleTranscript } satisfies CompressRequest),
    ).rejects.toMatchObject({
      name: "AIRequestError",
      code: "MOCK_COMPRESS_NOT_CONFIGURED",
    });
  });

  it("delegates to compressHandler", async () => {
    const adapter = new MockAdapter({
      handler: async function* () {
        yield { type: "message", content: "x" };
      },
      compressHandler: async () => ({
        replay: [
          {
            type: "message",
            role: "user",
            content: [{ type: "text", text: "summary" }],
          },
        ],
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      }),
    });
    const result = await adapter.compress({ model: "mock", input: sampleTranscript });
    expect(result.replay[0]).toMatchObject({ type: "message", role: "user" });
    expect(result.usage?.totalTokens).toBe(3);
  });
});
