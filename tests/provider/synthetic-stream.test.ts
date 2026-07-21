/**
 * syntheticStream 测试
 *
 * 验证非流式响应到规范事件流的包装行为。
 */

import { describe, it, expect } from "bun:test";

import { textBlock, messageItem, reasoningItem, toolCallItem, opaqueItem } from "../../src/index.js";

import { syntheticStream } from "../../src/provider/synthetic-stream.js";

import { aggregateEvents } from "../../src/stream/aggregator.js";
import type { AIStreamEvent } from "../../src/index.js";

import type { SyntheticStreamOptions } from "../../src/provider/synthetic-stream.js";
// ── Helpers ───────────────────────────────────────────────────

function makeOptions(overrides?: Partial<SyntheticStreamOptions>): SyntheticStreamOptions {
  return {
    model: "gpt-4o",
    responseId: "syn-test-1",
    backend: { kind: "chat-completions" },
    output: [],
    ...overrides,
  };
}

/** 收集 async iterable 为数组 */
async function collect(iter: AsyncIterable<AIStreamEvent>): Promise<AIStreamEvent[]> {
  const events: AIStreamEvent[] = [];
  for await (const e of iter) {
    events.push(e);
  }
  return events;
}

// ── 基础行为 ──────────────────────────────────────────────────

describe("syntheticStream - basic", () => {
  it("should start with response.started and end with response.completed", async () => {
    const events = await collect(syntheticStream(makeOptions()));
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]!.type).toBe("response.started");
    expect(events[events.length - 1]!.type).toBe("response.completed");
  });

  it("should set isSynthetic to true on all events", async () => {
    const events = await collect(syntheticStream(makeOptions()));
    for (const event of events) {
      expect(event.backend.isSynthetic).toBe(true);
    }
  });

  it("should carry the correct backend kind", async () => {
    const events = await collect(syntheticStream(makeOptions({ backend: { kind: "responses" } })));
    for (const event of events) {
      expect(event.backend.kind).toBe("responses");
    }
  });
});

// ── Item 事件发射 ─────────────────────────────────────────────

describe("syntheticStream - items", () => {
  it("should emit message events for a MessageItem", async () => {
    const events = await collect(
      syntheticStream(
        makeOptions({
          output: [messageItem([textBlock("Hello world")], { id: "m1" })],
        }),
      ),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("message.started");
    expect(types).toContain("message.delta");
    expect(types).toContain("message.completed");

    const delta = events.find((e) => e.type === "message.delta");
    if (delta?.type === "message.delta") {
      expect(delta.delta.type === "text" ? delta.delta.text : undefined).toBe("Hello world");
    }
  });

  it("should emit reasoning events for a ReasoningItem", async () => {
    const events = await collect(
      syntheticStream(
        makeOptions({
          output: [reasoningItem([textBlock("thinking...")], "full", "r1")],
        }),
      ),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("reasoning.started");
    expect(types).toContain("reasoning.delta");
    expect(types).toContain("reasoning.completed");
  });

  it("should emit tool_call events for a ToolCallItem", async () => {
    const events = await collect(
      syntheticStream(
        makeOptions({
          output: [toolCallItem("tc1", "get_weather", '{"city":"Hangzhou"}')],
        }),
      ),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("tool_call.started");
    expect(types).toContain("tool_call.delta");
    expect(types).toContain("tool_call.completed");

    const delta = events.find((e) => e.type === "tool_call.delta");
    if (delta?.type === "tool_call.delta") {
      expect(delta.delta.argumentsText).toBe('{"city":"Hangzhou"}');
    }
  });

  it("should preserve item order in output", async () => {
    const events = await collect(
      syntheticStream(
        makeOptions({
          output: [
            reasoningItem([textBlock("think")], "full", "r1"),
            messageItem([textBlock("Answer")], { id: "m1" }),
            toolCallItem("tc1", "search", "{}"),
          ],
        }),
      ),
    );

    // 提取 item completed 事件的顺序（排除 response.completed）
    const itemCompletedTypes = events
      .filter((e) => e.type !== "response.completed" && e.type.endsWith(".completed"))
      .map((e) => e.type);

    expect(itemCompletedTypes).toEqual(["reasoning.completed", "message.completed", "tool_call.completed"]);
  });

  it("should skip opaque items without emitting events", async () => {
    const events = await collect(
      syntheticStream(
        makeOptions({
          output: [
            messageItem([textBlock("hi")], { id: "m1" }),
            opaqueItem("responses", "replay", { key: "val" }, "op1"),
          ],
        }),
      ),
    );

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t.includes("opaque"))).toHaveLength(0);
    // 用 aggregateEvents 验证 opaque item 出现在最终 AIResponse 中
    const result = aggregateEvents(events);
    expect(result.output).toHaveLength(2);
    expect(result.output[1]!.type).toBe("opaque");
  });

  it("should handle empty output gracefully", async () => {
    const events = await collect(syntheticStream(makeOptions({ output: [] })));
    const result = aggregateEvents(events);
    expect(result.output).toEqual([]);
    expect(result.text).toBe("");
  });
});

// ── 辅助信息和 metadata ──────────────────────────────────────

describe("syntheticStream - metadata", () => {
  it("should emit response.auxiliary when usage is present", async () => {
    const events = await collect(
      syntheticStream(
        makeOptions({
          output: [messageItem([textBlock("hi")])],
          usage: { inputTokens: 10, outputTokens: 2 },
        }),
      ),
    );

    const aux = events.find((e) => e.type === "response.auxiliary");
    expect(aux).toBeDefined();
    if (aux?.type === "response.auxiliary") {
      expect(aux.usage?.inputTokens).toBe(10);
    }
  });

  it("should populate stopReason in final response", async () => {
    const events = await collect(
      syntheticStream(
        makeOptions({
          output: [messageItem([textBlock("hi")])],
          stopReason: "end_turn",
        }),
      ),
    );

    const completed = events.find((e) => e.type === "response.completed");
    if (completed?.type === "response.completed") {
      expect(completed.stopReason).toBe("end_turn");
    }
  });

  it("should include synthetic warning in final response", async () => {
    const events = await collect(syntheticStream(makeOptions()));
    const completed = events.find((e) => e.type === "response.completed");
    if (completed?.type === "response.completed") {
      expect(completed.warnings).toBeDefined();
      expect(completed.warnings!.some((w) => w.message.includes("synthetically"))).toBe(true);
    }
  });

  it("should merge extra warnings", async () => {
    const events = await collect(
      syntheticStream(
        makeOptions({
          warnings: [{ message: "Custom adapter warning" }],
        }),
      ),
    );
    const completed = events.find((e) => e.type === "response.completed");
    if (completed?.type === "response.completed") {
      expect(completed.warnings?.some((w) => w.message === "Custom adapter warning" || w.message.includes("Custom adapter warning"))).toBe(true);
    }
  });
});

// ── 与 aggregateEvents 集成 ──────────────────────────────────

describe("syntheticStream - integration with aggregateEvents", () => {
  it("should produce a valid AIResponse through collect+aggregate", async () => {
    const result = await aggregateEvents(
      await collect(
        syntheticStream(
          makeOptions({
            output: [
              reasoningItem([textBlock("thinking...")], "full", "r1"),
              messageItem([textBlock("Hello world")], { id: "m1" }),
            ],
            stopReason: "end_turn",
            usage: { inputTokens: 5, outputTokens: 3 },
          }),
        ),
      ),
    );

    expect(result.text).toBe("Hello world");
    expect(result.output).toHaveLength(2);
    expect(result.output[0]!.type).toBe("reasoning");
    expect(result.output[1]!.type).toBe("message");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage?.inputTokens).toBe(5);
    expect(result.usage?.outputTokens).toBe(3);
    expect(result.backend.isSyntheticStream).toBe(true);
    expect(result.backend.adapter).toBe("chat-completions");
  });

  it("should correctly aggregate tool calls", async () => {
    const result = await aggregateEvents(
      await collect(
        syntheticStream(
          makeOptions({
            output: [toolCallItem("tc1", "search", '{"q":"hello"}')],
            stopReason: "tool_call",
          }),
        ),
      ),
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("search");
    expect(result.toolCalls[0]!.argumentsText).toBe('{"q":"hello"}');
    expect(result.stopReason).toBe("tool_call");
  });

  it("should handle complex multi-item output with replay", async () => {
    const output = [
      reasoningItem([textBlock("step 1")], "full", "r1"),
      messageItem([textBlock("Answer here")], { id: "m1" }),
      toolCallItem("tc1", "get_weather", '{"city":"Hangzhou"}'),
    ];

    const events = await collect(
      syntheticStream(
        makeOptions({
          output,
          replay: output.map((o) => o as any),
          stopReason: "tool_call",
          usage: { inputTokens: 20, outputTokens: 15 },
        }),
      ),
    );

    const result = aggregateEvents(events);
    expect(result.output).toHaveLength(3);
    expect(result.replay).toHaveLength(3);
    expect(result.text).toBe("Answer here");
    expect(result.usage?.inputTokens).toBe(20);
  });
});
