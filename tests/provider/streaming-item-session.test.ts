/**
 * StreamingItemSession — 大块 E 事件权威 item 状态机
 */

import { describe, expect, it } from "bun:test";

import { AIStreamError, replayFromOutput, textBlock } from "../../src/index.js";
import type { AIStreamEvent, OutputItem, ServerToolResultItem } from "../../src/index.js";
import { createStreamingItemSession } from "../../src/provider/streaming-item-session.js";
import { createEventFactory } from "../../src/stream/event-factory.js";
import { aggregateEvents } from "../../src/stream/aggregator.js";

function factory() {
  return createEventFactory({
    responseId: "sess-test",
    backend: { kind: "mock", isSynthetic: true },
  });
}

describe("StreamingItemSession", () => {
  it("should emit message lifecycle and record completed item", () => {
    const session = createStreamingItemSession(factory());
    const events: AIStreamEvent[] = [
      session.startMessage("m1"),
      session.deltaMessage("m1", textBlock("He")),
      session.deltaMessage("m1", textBlock("llo")),
      session.completeMessage("m1"),
    ];

    expect(events.map((e) => e.type)).toEqual([
      "message.started",
      "message.delta",
      "message.delta",
      "message.completed",
    ]);
    expect(session.completedItems()).toEqual([
      {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    ]);
  });

  it("should coalesce adjacent text blocks in completed items", () => {
    const session = createStreamingItemSession(factory());
    session.startMessage("m1");
    session.deltaMessage("m1", textBlock("a"));
    session.deltaMessage("m1", textBlock("b"));
    session.completeMessage("m1");
    const item = session.completedItems()[0]!;
    expect(item.type).toBe("message");
    if (item.type === "message") {
      expect(item.content).toEqual([{ type: "text", text: "ab" }]);
    }
  });

  it("should keep empty message items (event truth)", () => {
    const session = createStreamingItemSession(factory());
    session.startMessage("empty");
    session.completeMessage("empty");
    expect(session.completedItems()).toHaveLength(1);
    const item = session.completedItems()[0]!;
    expect(item.type).toBe("message");
    if (item.type === "message") {
      expect(item.content).toEqual([]);
    }
  });

  it("should support ensureMessageStarted idempotency", () => {
    const session = createStreamingItemSession(factory());
    const first = session.ensureMessageStarted("m1");
    const second = session.ensureMessageStarted("m1");
    expect(first?.type).toBe("message.started");
    expect(second).toBeNull();
    session.completeMessage("m1");
  });

  it("should track tool_call and reasoning order", () => {
    const session = createStreamingItemSession(factory());
    session.startReasoning("r1", "full");
    session.deltaReasoning("r1", textBlock("think"));
    session.completeReasoning("r1");
    session.startMessage("m1");
    session.deltaMessage("m1", textBlock("hi"));
    session.completeMessage("m1");
    session.startToolCall("c1", "search");
    session.deltaToolCall("c1", { argumentsText: '{"q":1}' });
    session.completeToolCall("c1");

    expect(session.completedItems().map((i: OutputItem) => i.type)).toEqual(["reasoning", "message", "tool_call"]);
    const tool = session.completedItems()[2]!;
    expect(tool).toMatchObject({ type: "tool_call", id: "c1", name: "search", argumentsText: '{"q":1}' });
  });

  it("should support server_tool + result atomic items", () => {
    const session = createStreamingItemSession(factory());
    session.startServerTool("st1", "web_search", { name: "search" });
    session.deltaServerTool("st1", { argumentsText: '{"q":"x"}' });
    session.completeServerTool("st1", { status: "completed" });

    const result: ServerToolResultItem = {
      type: "server_tool_result",
      callId: "st1",
      tool: "web_search",
      outcome: "success",
      content: [textBlock("ok")],
    };
    session.completeServerToolResult(result);

    expect(session.completedItems().map((i: OutputItem) => i.type)).toEqual([
      "server_tool_call",
      "server_tool_result",
    ]);
  });

  it("should throw on delta without start", () => {
    const session = createStreamingItemSession(factory());
    expect(() => session.deltaMessage("missing", textBlock("x"))).toThrow(AIStreamError);
  });

  it("should throw on double start", () => {
    const session = createStreamingItemSession(factory());
    session.startMessage("m1");
    expect(() => session.startMessage("m1")).toThrow(AIStreamError);
  });

  it("should match aggregator output when events are aggregated", () => {
    const f = factory();
    const session = createStreamingItemSession(f);
    const streamEvents: AIStreamEvent[] = [
      f.responseStarted("model"),
      session.startMessage("m1"),
      session.deltaMessage("m1", textBlock("Hi")),
      session.completeMessage("m1"),
      session.startToolCall("t1", "search"),
      session.deltaToolCall("t1", { argumentsText: "{}" }),
      session.completeToolCall("t1"),
      f.responseCompleted({
        replay: [...replayFromOutput(session.completedItems())],
        stopReason: "tool_call",
      }),
    ];

    const aggregated = aggregateEvents(streamEvents);
    expect(aggregated.output).toEqual([...session.completedItems()]);
    expect(aggregated.toolCalls).toHaveLength(1);
    expect(aggregated.text).toBe("Hi");
  });
});
