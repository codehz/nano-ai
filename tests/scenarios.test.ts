/**
 * 端到端场景测试
 *
 * 覆盖统一抽象边界的完整交互场景，使用 golden 事件序列验证。
 */

import { describe, it, expect } from "bun:test";

import {
  aggregateEvents,
  collectStream,
  createAIClient,
  createEventFactory,
  textBlock,
  messageItem,
  toolResultItem,
  replayFromOutput,
} from "../src/index.js";

import type { AIStreamEvent, BackendAdapter, NormalizedRequest } from "../src/index.js";

import {
  goldenMessageReasoningToolCallSequence,
  goldenTextOnlySequence,
  goldenWarningSequence,
  goldenInterruptedSequence,
  sampleItems,
} from "./fixtures.js";

// ── Helper: 将事件数组包装为 AsyncIterable ───────────────────

async function* iter(events: AIStreamEvent[]): AsyncIterable<AIStreamEvent> {
  for (const e of events) {
    yield e;
  }
}

// ── 单轮文本流 ──────────────────────────────────────────────

describe("Scenario: single-turn text flow", () => {
  it("should aggregate golden text-only sequence correctly", () => {
    const result = aggregateEvents(goldenTextOnlySequence());
    expect(result.text).toBe("Hi there!");
    expect(result.output).toHaveLength(1);
    expect(result.output[0]!.type).toBe("message");
    expect(result.stopReason).toBe("end_turn");
    expect(result.toolCalls).toEqual([]);
  });

  it("should produce same result via collectStream", async () => {
    const result = await collectStream(iter(goldenTextOnlySequence()));
    expect(result.text).toBe("Hi there!");
    expect(result.output).toHaveLength(1);
  });

  it("should maintain stable aggregation across multiple runs", () => {
    const r1 = aggregateEvents(goldenTextOnlySequence());
    const r2 = aggregateEvents(goldenTextOnlySequence());
    expect(r1.text).toBe(r2.text);
    expect(r1.output).toEqual(r2.output);
  });
});

// ── Reasoning 流 ─────────────────────────────────────────────

describe("Scenario: reasoning flow", () => {
  it("should aggregate reasoning + message + tool_call in correct order", () => {
    const result = aggregateEvents(goldenMessageReasoningToolCallSequence());
    expect(result.output).toHaveLength(3);
    expect(result.output[0]!.type).toBe("reasoning");
    expect(result.output[1]!.type).toBe("message");
    expect(result.output[2]!.type).toBe("tool_call");
  });

  it("should produce correct text (reasoning excluded)", () => {
    const result = aggregateEvents(goldenMessageReasoningToolCallSequence());
    expect(result.text).toBe("Hi there!");
  });

  it("should produce correct toolCalls", () => {
    const result = aggregateEvents(goldenMessageReasoningToolCallSequence());
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("get_weather");
    expect(result.toolCalls[0]!.argumentsText).toBe('{"city":"Hangzhou"}');
  });
});

// ── 工具调用流 ──────────────────────────────────────────────

describe("Scenario: tool call flow", () => {
  it("should aggregate pure tool_call sequence", () => {
    const f = responsesFactory();
    const tc = sampleItems.toolCall("tc1");
    const events = [
      f.responseStarted("gpt-4o"),
      f.toolCallStarted("tc1", "get_weather"),
      f.toolCallDelta("tc1", { argumentsText: '{"city":"' }),
      f.toolCallDelta("tc1", { argumentsText: 'Hangzhou"}' }),
      f.toolCallCompleted("tc1"),
      f.responseCompleted({
        replay: [tc],
        stopReason: "tool_call",
        trace: { adapter: "responses", isSyntheticStream: false },
      }),
    ];

    const result = aggregateEvents(events);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.text).toBe("");
    expect(result.stopReason).toBe("tool_call");
  });
});

// ── Replay 回放 ─────────────────────────────────────────────

describe("Scenario: replay round-trip", () => {
  it("should produce replay from output via replayFromOutput", () => {
    const output = [sampleItems.assistantReply("m1"), sampleItems.toolCall("tc1")];
    const replay = replayFromOutput(output);
    expect(replay).toHaveLength(2);
    expect(replay[0]!.type).toBe("message");
    expect(replay[1]!.type).toBe("tool_call");
  });

  it("should preserve opaque items in replay", () => {
    const output = [
      sampleItems.assistantReply("m1"),
      {
        type: "opaque" as const,
        source: "responses" as const,
        purpose: "replay" as const,
        payload: { id: "cont-123" },
      },
    ];
    const replay = replayFromOutput(output);
    expect(replay).toHaveLength(2);
    expect(replay[1]!.type).toBe("opaque");
  });
});

// ── 手动工具循环 ────────────────────────────────────────────

describe("Scenario: manual tool loop", () => {
  // 模拟一个完整工具循环：
  // Round 1: model returns tool_call → caller runs tool → Round 2: model gets result
  it("should simulate tool loop via two stream rounds", async () => {
    // Round 1: user asks, model calls tool
    const round1Input = [sampleItems.userHello()];
    const round1Output = [sampleItems.toolCall("tc1")];
    const round1Replay = replayFromOutput(round1Output);

    // Tool execution (caller side)
    const toolResult = toolResultItem("tc1", "get_weather", "success", [textBlock("Sunny, 28°C")]);

    // Round 2: user + replay + tool_result → model responds
    const round2Input = [...round1Input, ...round1Replay, toolResult];

    // Verify input assembly
    expect(round2Input).toHaveLength(3);
    expect(round2Input[0]!.type).toBe("message");
    expect(round2Input[1]!.type).toBe("tool_call");
    expect(round2Input[2]!.type).toBe("tool_result");

    // Round 2 response would be assembled similarly
    const round2Output = [sampleItems.assistantReply("m2")];
    expect(round2Output[0]!.content[0]).toEqual({ type: "text", text: "Hi there!" });
  });

  it("should handle tool call → tool_result → next round via createAIClient", async () => {
    // 使用 mock adapter 模拟两轮对话
    let round = 0;
    const mockAdapter: BackendAdapter = {
      kind: "responses",
      capabilities: {
        textStreaming: "native",
        reasoningStreaming: "native",
        toolCallStreaming: "native",
        replay: "canonical",
        usage: "final",
        toolResultOutcomes: ["success"],
      } as const,
      stream(_request: NormalizedRequest): AsyncIterable<AIStreamEvent> {
        const f = responsesFactory();
        round++;
        if (round === 1) {
          // First round: tool call
          const tc = sampleItems.toolCall("tc1");
          return iter([
            f.responseStarted("gpt-4o"),
            f.toolCallStarted("tc1", "get_weather"),
            f.toolCallDelta("tc1", { argumentsText: '{"city":"Hangzhou"}' }),
            f.toolCallCompleted("tc1"),
            f.responseCompleted({
              replay: [tc],
              stopReason: "tool_call",
              trace: { adapter: "responses", isSyntheticStream: false },
            }),
          ]);
        }
        // Second round: text response
        const m2 = messageItem([textBlock("The weather is sunny and 28°C.")], { id: "m2" });
        return iter([
          f.responseStarted("gpt-4o"),
          f.messageStarted("m2"),
          f.messageDelta("m2", textBlock("The weather is sunny and 28°C.")),
          f.messageCompleted("m2"),
          f.responseCompleted({
            replay: [m2],
            stopReason: "end_turn",
            trace: { adapter: "responses", isSyntheticStream: false },
          }),
        ]);
      },
    };

    const client = createAIClient({ adapter: mockAdapter, model: "gpt-4o" });

    // Round 1
    const r1 = await collectStream(
      client.stream({
        input: [sampleItems.userHello()],
        tools: [{ name: "get_weather", inputSchema: {} }],
      }),
    );
    expect(r1.toolCalls).toHaveLength(1);
    expect(r1.stopReason).toBe("tool_call");

    // Execute tool (simulated)
    const toolResult = toolResultItem(r1.toolCalls[0]!.id, r1.toolCalls[0]!.name, "success", [
      textBlock("Sunny, 28°C"),
    ]);

    // Round 2
    const r2 = await collectStream(
      client.stream({
        input: [sampleItems.userHello(), ...r1.replay, toolResult],
      }),
    );
    expect(r2.text).toBe("The weather is sunny and 28°C.");
    expect(r2.stopReason).toBe("end_turn");
    expect(r2.output).toHaveLength(1);
  });
});

// ── Usage / Billing 回填 ────────────────────────────────────

describe("Scenario: usage/billing backfill", () => {
  it("should include usage from response.completed", () => {
    const f = responsesFactory();
    const m = sampleItems.assistantReply("m1");
    const events = [
      f.responseStarted("gpt-4o"),
      f.messageStarted("m1"),
      f.messageDelta("m1", textBlock("Hi")),
      f.messageCompleted("m1"),
      f.responseCompleted({
        replay: [m],
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        trace: { adapter: "responses", isSyntheticStream: false },
      }),
    ];

    const result = aggregateEvents(events);
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(2);
  });

  it("should include billing from response.completed", () => {
    const f = responsesFactory();
    const m = sampleItems.assistantReply("m1");
    const events = [
      f.responseStarted("gpt-4o"),
      f.messageStarted("m1"),
      f.messageDelta("m1", textBlock("Hi")),
      f.messageCompleted("m1"),
      f.responseCompleted({
        replay: [m],
        billing: { amount: 0.002, currency: "USD", isEstimated: false, source: "provider" },
        trace: { adapter: "responses", isSyntheticStream: false },
      }),
    ];

    const result = aggregateEvents(events);
    expect(result.billing?.amount).toBe(0.002);
    expect(result.billing?.isEstimated).toBe(false);
  });
});

// ── 降级 Warning ────────────────────────────────────────────

describe("Scenario: degradation warnings", () => {
  it("should aggregate warning events correctly", () => {
    const result = aggregateEvents(goldenWarningSequence());
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings![0]).toContain("Usage");
    expect(result.warnings![1]).toContain("Replay");
  });

  it("should not prevent successful result when warnings are present", () => {
    const result = aggregateEvents(goldenWarningSequence());
    expect(result.text).toBe("Hi there!");
    expect(result.output).toHaveLength(1);
  });
});

// ── 中途断流 ────────────────────────────────────────────────

describe("Scenario: mid-stream interruption", () => {
  it("should throw when stream is interrupted", () => {
    expect(() => aggregateEvents(goldenInterruptedSequence())).toThrow();
  });

  it("should reject collectStream when stream is interrupted", async () => {
    await expect(collectStream(iter(goldenInterruptedSequence()))).rejects.toThrow();
  });
});

// ── 跨 adapter 一致性 ───────────────────────────────────────

describe("Scenario: cross-adapter consistency", () => {
  // 验证不同 adapter 输出的 canonical 结构是否一致
  it("should produce same AIResponse shape from golden sequences", () => {
    const result = aggregateEvents(goldenTextOnlySequence());
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("output");
    expect(result).toHaveProperty("replay");
    expect(result).toHaveProperty("text");
    expect(result).toHaveProperty("toolCalls");
    expect(result).toHaveProperty("backend");
    expect(result).toHaveProperty("backend.adapter");
    expect(result).toHaveProperty("backend.isSyntheticStream");
  });

  it("should always have backend information", () => {
    const r1 = aggregateEvents(goldenTextOnlySequence());
    const r2 = aggregateEvents(goldenMessageReasoningToolCallSequence());

    expect(r1.backend.adapter).toBe("responses");
    expect(r1.backend.isSyntheticStream).toBe(false);
    expect(r2.backend.adapter).toBe("responses");
    expect(r2.backend.isSyntheticStream).toBe(false);
  });
});

function responsesFactory() {
  return createEventFactory({
    responseId: "scenario",
    backend: { kind: "responses" as const, isSynthetic: false },
  });
}
