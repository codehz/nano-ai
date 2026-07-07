/**
 * 测试 Fixtures
 *
 * 共享的构造器和样本数据，用于场景测试和 golden sequence 验证。
 */

import { createEventFactory, textBlock, messageItem, reasoningItem, toolCallItem } from "../src/index.js";

import type { AIStreamEvent, AIResponse, MessageItem, ReasoningItem, ToolCallItem } from "../src/index.js";

// ── 工厂辅助 ──────────────────────────────────────────────────

export function responsesFactory() {
  return createEventFactory({
    responseId: "fixture-resp",
    backend: { kind: "responses", isSynthetic: false },
  });
}

export function syntheticFactory() {
  return createEventFactory({
    responseId: "fixture-synth",
    backend: { kind: "chat-completions", isSynthetic: true },
  });
}

// ── 样本 item ─────────────────────────────────────────────────

export const sampleItems = {
  userHello: (): MessageItem => ({
    type: "message",
    role: "user",
    content: [textBlock("Hello")],
  }),

  assistantReply: (id = "m1"): MessageItem => messageItem([textBlock("Hi there!")], { id }),

  reasoning: (id = "r1"): ReasoningItem => reasoningItem([textBlock("thinking step 1...")], "full", id),

  toolCall: (id = "tc1"): ToolCallItem => toolCallItem(id, "get_weather", '{"city":"Hangzhou"}'),

  toolResult: () => ({
    type: "tool_result" as const,
    callId: "tc1",
    toolName: "get_weather",
    outcome: "success" as const,
    content: [textBlock("Sunny, 28°C")],
  }),
};

// ── Golden 事件序列 ───────────────────────────────────────────

/**
 * 返回一个「消息 + reasoning + 工具调用」的完整 golden 事件序列。
 * 用于验证聚合结果是否稳定可预测。
 */
export function goldenMessageReasoningToolCallSequence(): AIStreamEvent[] {
  const f = responsesFactory();
  const m = sampleItems.assistantReply("m1");
  const r = sampleItems.reasoning("r1");
  const tc = sampleItems.toolCall("tc1");

  return [
    f.responseStarted("gpt-4o"),

    // reasoning block
    f.reasoningStarted("r1", "full"),
    f.reasoningDelta("r1", textBlock("thinking step 1...")),
    f.reasoningCompleted(r),

    // message block
    f.messageStarted("m1"),
    f.messageDelta("m1", "Hi there!"),
    f.messageCompleted(m),

    // tool_call block
    f.toolCallStarted("tc1", "get_weather"),
    f.toolCallDelta("tc1", { argumentsText: '{"city":"Hangzhou"}' }),
    f.toolCallCompleted(tc),

    // completed
    f.responseCompleted({
      id: "golden-1",
      output: [r, m, tc],
      replay: [r, m, tc],
      text: "Hi there!",
      toolCalls: [tc],
      stopReason: "tool_call",
      backend: { adapter: "responses", isSyntheticStream: false },
    }),
  ];
}

/**
 * 纯文本 golden 序列。
 */
export function goldenTextOnlySequence(): AIStreamEvent[] {
  const f = responsesFactory();
  const m = sampleItems.assistantReply("m1");

  return [
    f.responseStarted("gpt-4o"),
    f.messageStarted("m1"),
    f.messageDelta("m1", "Hi there!"),
    f.messageCompleted(m),
    f.responseCompleted({
      id: "golden-text",
      output: [m],
      replay: [m],
      text: "Hi there!",
      toolCalls: [],
      stopReason: "end_turn",
      backend: { adapter: "responses", isSyntheticStream: false },
    }),
  ];
}

/**
 * Warning 降级 golden 序列。
 */
export function goldenWarningSequence(): AIStreamEvent[] {
  const f = responsesFactory();
  const m = sampleItems.assistantReply("m1");

  return [
    f.responseStarted("gpt-4o"),
    f.responseWarning("Usage information was not provided", "USAGE_MISSING"),
    f.responseWarning("Replay fidelity is low for this provider", "REPLAY_FIDELITY_LOW"),
    f.messageStarted("m1"),
    f.messageDelta("m1", "Hi there!"),
    f.messageCompleted(m),
    f.responseCompleted({
      id: "golden-warn",
      output: [m],
      replay: [m],
      text: "Hi there!",
      toolCalls: [],
      warnings: ["Usage information was not provided", "Replay fidelity is low for this provider"],
      backend: { adapter: "responses", isSyntheticStream: false },
    }),
  ];
}

/**
 * 中断序列（无 response.completed）。
 */
export function goldenInterruptedSequence(): AIStreamEvent[] {
  const f = responsesFactory();
  return [
    f.responseStarted("gpt-4o"),
    f.messageStarted("m1"),
    f.messageDelta("m1", "Partial output"),
    // 故意没有 message.completed 和 response.completed
  ];
}

// ── 样本 AIResponse ──────────────────────────────────────────

export function sampleResponse(overrides?: Partial<AIResponse>): AIResponse {
  return {
    id: "sample-resp",
    output: [sampleItems.assistantReply()],
    replay: [sampleItems.assistantReply()],
    text: "Hi there!",
    toolCalls: [],
    stopReason: "end_turn",
    backend: { adapter: "responses", isSyntheticStream: false },
    ...overrides,
  };
}
