import { describe, it, expect } from "bun:test";

import { mapStopReason, mapReasoningVisibility, textBlock, jsonBlock, imageBlock, opaqueBlock, messageItem, reasoningItem, toolCallItem, toolResultItem, opaqueItem, replayFromOutput, AIMappingError, AIProviderError, collectStream } from "../../src/index.js";

import { AdapterBase } from "../../src/provider/base.js";
import type { NormalizedRequest, AIStreamEvent } from "../../src/index.js";

import type { EventFactory } from "../../src/stream/event-factory.js";
// ── mapStopReason ─────────────────────────────────────────────

describe("mapStopReason", () => {
  it("should map OpenAI stop reasons", () => {
    expect(mapStopReason("stop")).toBe("end_turn");
    expect(mapStopReason("length")).toBe("max_output_tokens");
    expect(mapStopReason("content_filter")).toBe("content_filter");
    expect(mapStopReason("tool_calls")).toBe("tool_call");
  });

  it("should map Anthropic stop reasons", () => {
    expect(mapStopReason("end_turn")).toBe("end_turn");
    expect(mapStopReason("max_tokens")).toBe("max_output_tokens");
  });

  it("should map generic error", () => {
    expect(mapStopReason("error")).toBe("error");
  });

  it("should fallback to unknown", () => {
    expect(mapStopReason("some_random_reason")).toBe("unknown");
  });
});

// ── mapReasoningVisibility ────────────────────────────────────

describe("mapReasoningVisibility", () => {
  it("should map full visibility", () => {
    expect(mapReasoningVisibility(true, false)).toBe("full");
  });

  it("should map redacted visibility", () => {
    expect(mapReasoningVisibility(true, true)).toBe("redacted");
  });

  it("should map opaque visibility", () => {
    expect(mapReasoningVisibility(false, false)).toBe("opaque");
  });
});

// ── Content block helpers ─────────────────────────────────────

describe("content block helpers", () => {
  it("textBlock should create a text block", () => {
    expect(textBlock("hello")).toEqual({ type: "text", text: "hello" });
  });

  it("jsonBlock should create a json block", () => {
    expect(jsonBlock({ key: "val" })).toEqual({ type: "json", json: { key: "val" } });
  });

  it("imageBlock should create an image block", () => {
    expect(imageBlock("https://example.com/img.png")).toEqual({
      type: "image",
      imageUrl: "https://example.com/img.png",
    });
  });

  it("opaqueBlock should create an opaque block", () => {
    const payload = { raw: true };
    expect(opaqueBlock(payload)).toEqual({ type: "opaque", payload });
  });
});

// ── Item helpers ──────────────────────────────────────────────

describe("item helpers", () => {
  it("messageItem should create a MessageItem", () => {
    const item = messageItem([textBlock("hi")], { role: "user" });
    expect(item.type).toBe("message");
    expect(item.role).toBe("user");
    expect(item.content).toHaveLength(1);
  });

  it("messageItem should default to assistant role", () => {
    const item = messageItem([textBlock("hello")]);
    expect(item.role).toBe("assistant");
  });

  it("reasoningItem should create a ReasoningItem", () => {
    const item = reasoningItem([textBlock("step 1")], "full", "r1");
    expect(item.type).toBe("reasoning");
    expect(item.visibility).toBe("full");
    expect(item.id).toBe("r1");
  });

  it("reasoningItem should default visibility to full", () => {
    const item = reasoningItem([textBlock("thinking")]);
    expect(item.visibility).toBe("full");
  });

  it("toolCallItem should create a ToolCallItem", () => {
    const item = toolCallItem("tc1", "get_weather", '{"city":"Hangzhou"}');
    expect(item.type).toBe("tool_call");
    expect(item.name).toBe("get_weather");
    expect(item.argumentsText).toBe('{"city":"Hangzhou"}');
  });

  it("toolResultItem should create a ToolResultItem", () => {
    const item = toolResultItem("tc1", "get_weather", "success", [jsonBlock({ temp: 28 })]);
    expect(item.type).toBe("tool_result");
    expect(item.outcome).toBe("success");
  });

  it("opaqueItem should create an OpaqueItem", () => {
    const item = opaqueItem("responses", "replay", { id: "cont-123" }, "op-1");
    expect(item.type).toBe("opaque");
    expect(item.source).toBe("responses");
    expect(item.purpose).toBe("replay");
  });
});

// ── replayFromOutput ──────────────────────────────────────────

describe("replayFromOutput", () => {
  it("should convert output items to replay items", () => {
    const output = [
      messageItem([textBlock("Hello")]),
      reasoningItem([textBlock("thinking")], "full", "r1"),
      toolCallItem("tc1", "search", "{}"),
    ];
    const replay = replayFromOutput(output);
    expect(replay).toHaveLength(3);
    expect(replay[0]!.type).toBe("message");
    expect(replay[1]!.type).toBe("reasoning");
    expect(replay[2]!.type).toBe("tool_call");
  });

  it("should preserve opaque items", () => {
    const output = [opaqueItem("responses", "replay", { key: "val" })];
    const replay = replayFromOutput(output);
    expect(replay).toHaveLength(1);
    expect(replay[0]!.type).toBe("opaque");
  });

  it("should return empty array for empty output", () => {
    expect(replayFromOutput([])).toEqual([]);
  });
});

// ── AdapterBase ───────────────────────────────────────────────

describe("AdapterBase", () => {
  // 创建一个最小 adapter 实现用于测试
  class TestAdapter extends AdapterBase {
    readonly kind = "responses" as const;
    readonly isSyntheticStream = true;

    protected buildRequest(request: NormalizedRequest): string {
      return JSON.stringify(request);
    }

    protected async *runStream(
      _providerRequest: string,
      factory: EventFactory,
      request: NormalizedRequest,
    ): AsyncIterable<AIStreamEvent> {
      yield factory.messageStarted("m1");
      yield factory.messageDelta("m1", textBlock("Hello world"));
      yield factory.messageCompleted("m1");

      const output = [messageItem([textBlock("Hello world")], { id: "m1" })];
      const resp = this.buildResponse(
        request,
        {
          output,
          replay: output,
          stopReason: "end_turn",
          usage: { inputTokens: 5, outputTokens: 2 },
        },
        factory,
      );
      yield factory.responseCompleted({
        replay: resp.replay,
        stopReason: resp.stopReason,
        usage: resp.usage,
        billing: resp.billing,
        auxiliary: resp.auxiliary,
        warnings: resp.warnings,
        trace: resp.backend,
      });
    }
  }

  it("should return an async iterable from stream()", async () => {
    const adapter = new TestAdapter();
    const request: NormalizedRequest = {
      model: "gpt-4",
      requestId: "req-1",
      input: [],
    };
    const stream = adapter.stream(request);
    const events: AIStreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]!.type).toBe("response.started");
    expect(events[events.length - 1]!.type).toBe("response.completed");
  });

  it("should expose kind and stream source from instance", () => {
    const adapter = new TestAdapter();
    expect(adapter.kind).toBe("responses");
    expect(adapter.isSyntheticStream).toBe(true);
  });

  it("should build response with correct text", async () => {
    const adapter = new TestAdapter();
    const request: NormalizedRequest = {
      model: "gpt-4",
      requestId: "req-2",
      input: [],
    };
    const events: AIStreamEvent[] = [];
    for await (const event of adapter.stream(request)) {
      events.push(event);
    }

    const result = await collectStream(adapter.stream(request));
    expect(result.text).toBe("Hello world");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage?.inputTokens).toBe(5);
    expect(result.usage?.outputTokens).toBe(2);
  });

  it("should rethrow provider request errors", async () => {
    class ErrorAdapter extends AdapterBase {
      readonly kind = "responses" as const;
      readonly isSyntheticStream = true;
      protected buildRequest(): never {
        throw new AIProviderError("API connection failed", "PROVIDER_ERROR", 503);
      }
      protected async *runStream(): AsyncIterable<AIStreamEvent> {
        // unreachable since buildRequest throws
      }
    }

    const adapter = new ErrorAdapter();
    await expect(
      (async () => {
        for await (const ignoredEvent of adapter.stream({ model: "gpt-4", requestId: "r", input: [] })) {
          void ignoredEvent;
          // consume
        }
      })(),
    ).rejects.toBeInstanceOf(AIProviderError);
  });

  it("should degrade mapping errors into warning + completed", async () => {
    class WarningAdapter extends AdapterBase {
      readonly kind = "responses" as const;
      readonly isSyntheticStream = true;

      protected buildRequest(): never {
        throw new AIMappingError("provider exploded", "MAPPING_ERROR");
      }

      protected async *runStream(): AsyncIterable<AIStreamEvent> {
        // unreachable since buildRequest throws
      }
    }

    const adapter = new WarningAdapter();
    const events: AIStreamEvent[] = [];
    for await (const event of adapter.stream({ model: "gpt-4", requestId: "warn-r", input: [] })) {
      events.push(event);
    }

    const completed = events.find((e) => e.type === "response.completed");
    expect(completed).toBeDefined();
    if (completed?.type === "response.completed") {
      expect(completed.warnings).toBeDefined();
      expect(completed.warnings![0]).toContain("provider exploded");
    }
  });

  it("should preserve requestId from NormalizedRequest", async () => {
    const adapter = new TestAdapter();
    const events: AIStreamEvent[] = [];
    for await (const event of adapter.stream({
      model: "gpt-4",
      requestId: "my-custom-id",
      input: [],
    })) {
      events.push(event);
    }
    const completed = events.find((e) => e.type === "response.completed");
    if (completed?.type === "response.completed") {
      expect(completed.trace?.requestId).toBe("my-custom-id");
    }
  });

  it("should set isSyntheticStream correctly", async () => {
    const adapter = new TestAdapter(); // textStreaming: "synthetic"
    const events: AIStreamEvent[] = [];
    for await (const event of adapter.stream({
      model: "gpt-4",
      requestId: "r",
      input: [],
    })) {
      events.push(event);
    }
    const completed = events.find((e) => e.type === "response.completed");
    if (completed?.type === "response.completed") {
      expect(completed.trace?.isSyntheticStream).toBe(true);
    }

    const started = events.find((e) => e.type === "response.started");
    if (started) {
      expect(started.backend.isSynthetic).toBe(true);
    }
  });

  it("should handle empty output gracefully", async () => {
    class EmptyAdapter extends AdapterBase {
      readonly kind = "responses" as const;
      readonly isSyntheticStream = false;
      protected buildRequest(r: NormalizedRequest) {
        return r;
      }
      protected async *runStream(
        _pr: unknown,
        factory: EventFactory,
        request: NormalizedRequest,
      ): AsyncIterable<AIStreamEvent> {
        const resp = this.buildResponse(request, { output: [], replay: [] }, factory);
        yield factory.responseCompleted({
          replay: resp.replay,
          stopReason: resp.stopReason,
          usage: resp.usage,
          billing: resp.billing,
          auxiliary: resp.auxiliary,
          warnings: resp.warnings,
          trace: resp.backend,
        });
      }
    }
    const adapter = new EmptyAdapter();
    const result = await collectStream(adapter.stream({ model: "gpt-4", requestId: "r", input: [] }));
    expect(result.output).toEqual([]);
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([]);
  });
});
