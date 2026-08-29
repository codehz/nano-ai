/**
 * DeltaCompletionsAdapter 测试
 *
 * 残缺 SSE：`data: {"choices":[{"delta":{"content":"..."}}]}`，无 index / finish_reason。
 */

import { describe, it, expect } from "bun:test";
import { AIRequestError, DeltaCompletionsAdapter, collectStream, WarningCode } from "../../src/index.js";
import type { NormalizedRequest, FetchFn } from "../../src/index.js";

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
    model: "local-model",
    requestId: "delta-req-1",
    input: [{ type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }],
    ...overrides,
  };
}

function adapter(fetch: FetchFn, options?: { apiKey?: string }): DeltaCompletionsAdapter {
  return new DeltaCompletionsAdapter({
    baseUrl: "http://vendor.local/v1",
    fetch,
    ...(options?.apiKey ? { apiKey: options.apiKey } : {}),
  });
}

describe("DeltaCompletionsAdapter", () => {
  it("requires baseUrl so it cannot be pointed at OpenAI by default", () => {
    expect(() => new DeltaCompletionsAdapter({ baseUrl: "" } as { baseUrl: string })).toThrow(AIRequestError);
  });

  it("reads content from bare choices/delta chunks without index or finish_reason", async () => {
    const result = await collectStream(
      adapter(
        mockFetch(
          sseResponse(
            'data: {"choices":[{"delta":{"content":"\\n"}}]}\n',
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
            "data: [DONE]\n",
          ),
        ),
      ).stream(makeRequest()),
    );

    expect(result.text).toBe("\nHello");
    expect(result.stopReason).toBe("end_turn");
    expect(result.backend.adapter).toBe("delta-completions");
    expect(result.output.filter((item) => item.type === "message")).toHaveLength(1);
    const opaque = result.replay.find((item) => item.type === "opaque");
    expect(opaque).toMatchObject({
      type: "opaque",
      source: "delta.completions",
      purpose: "replay",
      payload: {
        replaceCanonical: true,
        messages: [{ role: "assistant", content: "\nHello" }],
      },
    });
  });

  it("posts stream:true without n or tools and omits Authorization when apiKey is absent", async () => {
    let url = "";
    let headers: Headers | undefined;
    let body: Record<string, unknown> | null = null;

    const result = await collectStream(
      adapter(async (input, init) => {
        url = String(input);
        headers = new Headers(init?.headers);
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n', "data: [DONE]\n");
      }).stream(makeRequest()),
    );

    expect(result.text).toBe("ok");
    expect(url).toBe("http://vendor.local/v1/chat/completions");
    expect(headers?.get("Authorization")).toBeNull();
    expect(body).toMatchObject({
      model: "local-model",
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(body).not.toHaveProperty("n");
    expect(body).not.toHaveProperty("tools");
  });

  it("sends Bearer token only when apiKey is provided", async () => {
    const captured: { authorization: string | null } = { authorization: null };
    await collectStream(
      adapter(
        async (_input, init) => {
          captured.authorization = new Headers(init?.headers).get("Authorization");
          return sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n');
        },
        { apiKey: "secret" },
      ).stream(makeRequest()),
    );
    expect(captured.authorization).toBe("Bearer secret");
  });

  it("uses the first choices array element and ignores choice.index", async () => {
    const result = await collectStream(
      adapter(
        mockFetch(sseResponse('data: {"choices":[{"delta":{"content":"A"}},{"index":0,"delta":{"content":"B"}}]}\n')),
      ).stream(makeRequest()),
    );
    expect(result.text).toBe("A");
    expect(result.warnings?.some((w) => w.code === WarningCode.MULTIPLE_CHOICES_IGNORED)).toBe(true);
  });

  it("completes on stream end and maps finish_reason only when present", async () => {
    const withLength = await collectStream(
      adapter(
        mockFetch(sseResponse('data: {"choices":[{"delta":{"content":"cut"},"finish_reason":"length"}]}\n')),
      ).stream(makeRequest()),
    );
    expect(withLength.text).toBe("cut");
    expect(withLength.stopReason).toBe("max_output_tokens");
  });

  it("does not warn STREAM_INCOMPLETE when finish_reason is absent", async () => {
    const result = await collectStream(
      adapter(mockFetch(sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n'))).stream(makeRequest()),
    );
    expect(result.stopReason).toBe("end_turn");
    expect(result.warnings?.some((w) => w.code === WarningCode.STREAM_INCOMPLETE)).toBeFalsy();
  });

  it("ignores tool_calls and reasoning deltas instead of mapping them", async () => {
    const result = await collectStream(
      adapter(
        mockFetch(
          sseResponse(
            'data: {"choices":[{"delta":{"content":"Hi","tool_calls":[{"index":0,"id":"call_1","function":{"name":"x","arguments":"{}"}}],"reasoning_content":"think"}}]}\n',
          ),
        ),
      ).stream(makeRequest()),
    );
    expect(result.text).toBe("Hi");
    expect(result.toolCalls).toEqual([]);
    expect(result.output.some((item) => item.type === "reasoning" || item.type === "tool_call")).toBe(false);
    expect(result.warnings?.some((w) => w.code === WarningCode.CAPABILITY_DOWNGRADE)).toBe(true);
  });

  it("rejects tools in the request so ChatCompletionsAdapter is not silently substituted", async () => {
    await expect(
      collectStream(
        adapter(mockFetch(sseResponse('data: {"choices":[{"delta":{"content":"x"}}]}\n'))).stream(
          makeRequest({
            tools: [{ name: "search", inputSchema: { type: "object" } }],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_TOOL" });
  });

  it("rejects image content blocks", async () => {
    await expect(
      collectStream(
        adapter(mockFetch(sseResponse('data: {"choices":[{"delta":{"content":"x"}}]}\n'))).stream(
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

  it("replays opaque assistant text without duplicating the trailing turn", async () => {
    const round1 = await collectStream(
      adapter(
        mockFetch(sseResponse('data: {"choices":[{"delta":{"content":"from-model"}}]}\n', "data: [DONE]\n")),
      ).stream(makeRequest()),
    );
    const opaque = round1.replay.find((item) => item.type === "opaque");
    expect(opaque).toBeDefined();

    const captured: { body: Record<string, unknown> | null } = { body: null };
    await collectStream(
      adapter(async (_input, init) => {
        captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse('data: {"choices":[{"delta":{"content":"next"}}]}\n');
      }).stream(
        makeRequest({
          input: [
            { type: "message", role: "user", content: [{ type: "text", text: "Hello" }] },
            { type: "message", role: "assistant", content: [{ type: "text", text: "from-model" }] },
            opaque!,
            { type: "message", role: "user", content: [{ type: "text", text: "again" }] },
          ],
        }),
      ),
    );

    expect(captured.body).toMatchObject({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "from-model" },
        { role: "user", content: "again" },
      ],
    });
  });

  it("skips malformed JSON lines and continues", async () => {
    const result = await collectStream(
      adapter(mockFetch(sseResponse("data: {bad json}\n", 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n'))).stream(
        makeRequest(),
      ),
    );
    expect(result.text).toBe("Hi");
  });
});
