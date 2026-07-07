/**
 * 错误模型与中断语义测试
 *
 * 覆盖：
 * - 错误类型构造与鉴别
 * - 致命错误 → 同步抛错
 * - 中断语义 → 不伪造 response.completed
 * - 非致命差异 → warning 通道
 */

import { describe, it, expect } from "bun:test";
import {
  AIError,
  AIRequestError,
  AIProviderError,
  AIStreamError,
  AIMappingError,
  WarningCode,
  createEventFactory,
  aggregateEvents,
  collectStream,
  AdapterBase,
} from "../src/index.js";
import { textBlock, messageItem } from "../src/index.js";

import type { NormalizedRequest, AIStreamEvent, EventFactory, AdapterCapabilities } from "../src/index.js";

// ── 错误类型 ──────────────────────────────────────────────────

describe("Error types", () => {
  it("AIError should be base class with code", () => {
    const err = new AIError("generic", "GENERIC");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AIError");
    expect(err.code).toBe("GENERIC");
    expect(err.message).toBe("generic");
  });

  it("AIRequestError should have correct name and code", () => {
    const err = new AIRequestError("input is empty", "INPUT_EMPTY");
    expect(err).toBeInstanceOf(AIError);
    expect(err.name).toBe("AIRequestError");
    expect(err.code).toBe("INPUT_EMPTY");
  });

  it("AIProviderError should carry statusCode and responseBody", () => {
    const err = new AIProviderError("Unauthorized", "UNAUTHORIZED", 401, '{"error":"invalid api key"}');
    expect(err.name).toBe("AIProviderError");
    expect(err.statusCode).toBe(401);
    expect(err.responseBody).toBe('{"error":"invalid api key"}');
  });

  it("AIStreamError should have correct name", () => {
    const err = new AIStreamError("Invalid chunk", "INVALID_CHUNK");
    expect(err.name).toBe("AIStreamError");
  });

  it("AIMappingError should have correct name", () => {
    const err = new AIMappingError("Cannot map response", "MAPPING_FAILED");
    expect(err.name).toBe("AIMappingError");
  });

  it("should be distinguishable via instanceof", () => {
    const reqErr = new AIRequestError("bad", "BAD");
    const provErr = new AIProviderError("bad", "BAD");
    const streamErr = new AIStreamError("bad", "BAD");
    const mapErr = new AIMappingError("bad", "BAD");

    expect(reqErr).toBeInstanceOf(AIRequestError);
    expect(provErr).toBeInstanceOf(AIProviderError);
    expect(streamErr).toBeInstanceOf(AIStreamError);
    expect(mapErr).toBeInstanceOf(AIMappingError);

    expect(reqErr).toBeInstanceOf(AIError);
    expect(provErr).toBeInstanceOf(AIError);
    expect(streamErr).toBeInstanceOf(AIError);
    expect(mapErr).toBeInstanceOf(AIError);
  });
});

// ── WarningCode ───────────────────────────────────────────────

describe("WarningCode", () => {
  it("should have string constant values", () => {
    expect(WarningCode.REPLAY_FIDELITY_LOW).toBe("REPLAY_FIDELITY_LOW");
    expect(WarningCode.USAGE_MISSING).toBe("USAGE_MISSING");
    expect(WarningCode.STREAM_INCOMPLETE).toBe("STREAM_INCOMPLETE");
    expect(WarningCode.SYNTHETIC_STREAM).toBe("SYNTHETIC_STREAM");
  });
});

// ── 致命错误 ──────────────────────────────────────────────────

describe("Fatal errors", () => {
  it("should throw synchronously from createAIClient when input is empty", () => {
    // 这个测试验证 validateRequest 在进入 adapter 前就抛错
    const { normalizeRequest } = require("../src/index.js");
    expect(() => normalizeRequest({ input: [] }, { model: "gpt-4" })).toThrow(AIRequestError);
  });

  it("should throw when temperature is out of range", () => {
    const { normalizeRequest } = require("../src/index.js");
    expect(() =>
      normalizeRequest(
        {
          input: [
            { type: "message" as const, role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
          ],
          temperature: 3,
        },
        { model: "gpt-4" },
      ),
    ).toThrow(AIRequestError);
  });

  it("aggregateEvents should throw when stream lacks response.completed", () => {
    const f = createEventFactory({
      responseId: "r",
      backend: { kind: "responses", isSynthetic: false },
    });
    const events = [f.responseStarted("gpt-4")];

    expect(() => aggregateEvents(events)).toThrow("response.completed");
  });

  it("collectStream should reject when stream ends without response.completed", async () => {
    const f = createEventFactory({
      responseId: "r",
      backend: { kind: "responses", isSynthetic: false },
    });
    async function* incompleteStream(): AsyncIterable<AIStreamEvent> {
      yield f.responseStarted("gpt-4");
    }

    await expect(collectStream(incompleteStream())).rejects.toThrow("response.completed");
  });
});

// ── 流中断语义 ────────────────────────────────────────────────

describe("Stream interruption semantics", () => {
  it("should not produce AIResponse when stream is interrupted before response.completed", async () => {
    const f = createEventFactory({
      responseId: "r",
      backend: { kind: "responses", isSynthetic: false },
    });

    async function* interrupted(): AsyncIterable<AIStreamEvent> {
      yield f.responseStarted("gpt-4");
      yield f.messageStarted("m1");
      yield f.messageDelta("m1", "Partial");
      // 没有 message.completed, 没有 response.completed
      // 流在这里中断
    }

    await expect(collectStream(interrupted())).rejects.toThrow();
  });

  it("should not fabricate response.completed when stream is incomplete", () => {
    const f = createEventFactory({
      responseId: "r",
      backend: { kind: "responses", isSynthetic: false },
    });

    const events = [
      f.responseStarted("gpt-4"),
      f.messageStarted("m1"),
      f.messageDelta("m1", "Partial"),
      // 没有 response.completed
    ];

    expect(() => aggregateEvents(events)).toThrow();
  });

  it("adapter provider error should emit warning + empty completed (not throw)", async () => {
    // 使用 TestAdapter 模拟 provider 错误
    class ErrorAdapter extends AdapterBase {
      readonly kind = "responses" as const;
      readonly capabilities: AdapterCapabilities = {
        nativeStreaming: false,
        messageStreaming: true,
        reasoningStreaming: false,
        toolCallStreaming: false,
        hiddenReasoningReplay: "none",
        replayFidelity: "low",
        tools: false,
        usage: "none",
        billing: "none",
        providerMetadata: false,
      };
      protected buildRequest(): never {
        throw new AIProviderError("API key invalid", "AUTH_ERROR", 401);
      }
      protected async *runStream(): AsyncIterable<AIStreamEvent> {
        // unreachable
      }
    }

    const adapter = new ErrorAdapter();
    const events: AIStreamEvent[] = [];
    for await (const event of adapter.stream({
      model: "gpt-4",
      requestId: "r",
      input: [],
    })) {
      events.push(event);
    }

    // 应该有 warning
    const warnings = events.filter((e) => e.type === "response.warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);

    // 应该有 completed（不挂起调用方）
    const completed = events.find((e) => e.type === "response.completed");
    expect(completed).toBeDefined();
    if (completed?.type === "response.completed") {
      expect(completed.response.output).toEqual([]);
    }
  });

  it("should distinguish normal completion from interruption", async () => {
    const f = createEventFactory({
      responseId: "r",
      backend: { kind: "responses", isSynthetic: false },
    });

    // 正常完成
    const normalEvents = [
      f.responseStarted("gpt-4"),
      f.messageStarted("m1"),
      f.messageDelta("m1", "ok"),
      f.messageCompleted(messageItem([textBlock("ok")], { id: "m1" })),
      f.responseCompleted({
        id: "r",
        output: [],
        replay: [],
        text: "ok",
        toolCalls: [],
        backend: { adapter: "responses", isSyntheticStream: false },
      }),
    ];
    expect(() => aggregateEvents(normalEvents)).not.toThrow();

    // 中断
    const interruptedEvents = [f.responseStarted("gpt-4"), f.messageStarted("m1"), f.messageDelta("m1", "Partial")];
    expect(() => aggregateEvents(interruptedEvents)).toThrow();
  });
});

// ── 非致命差异 → warning 通道 ────────────────────────────────

describe("Non-fatal differences use warning channel", () => {
  it("should report usage missing as warning", () => {
    const f = createEventFactory({
      responseId: "r",
      backend: { kind: "responses", isSynthetic: false },
    });

    const events = [
      f.responseStarted("gpt-4"),
      f.responseWarning("Usage information was not provided by the provider", WarningCode.USAGE_MISSING),
      f.responseCompleted({
        id: "r",
        output: [],
        replay: [],
        text: "",
        toolCalls: [],
        backend: { adapter: "responses", isSyntheticStream: false },
      }),
    ];

    const result = aggregateEvents(events);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes("Usage"))).toBe(true);
  });

  it("should report replay fidelity downgrade as warning", () => {
    const f = createEventFactory({
      responseId: "r",
      backend: { kind: "responses", isSynthetic: false },
    });

    const events = [
      f.responseStarted("gpt-4"),
      f.responseWarning("Replay fidelity is low for this provider", WarningCode.REPLAY_FIDELITY_LOW),
      f.responseCompleted({
        id: "r",
        output: [],
        replay: [],
        text: "",
        toolCalls: [],
        backend: { adapter: "responses", isSyntheticStream: false },
      }),
    ];

    const result = aggregateEvents(events);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes("Replay"))).toBe(true);
  });

  it("should not treat warning-only events as fatal errors", () => {
    const f = createEventFactory({
      responseId: "r",
      backend: { kind: "responses", isSynthetic: false },
    });

    const events = [
      f.responseStarted("gpt-4"),
      f.responseWarning("Some non-fatal issue", "NON_FATAL"),
      f.responseCompleted({
        id: "r",
        output: [],
        replay: [],
        text: "",
        toolCalls: [],
        backend: { adapter: "responses", isSyntheticStream: false },
      }),
    ];

    // 不应抛错
    const result = aggregateEvents(events);
    expect(result).toBeDefined();
    expect(result.warnings).toHaveLength(1);
  });

  it("should report billing estimated as warning, not error", () => {
    const f = createEventFactory({
      responseId: "r",
      backend: { kind: "responses", isSynthetic: false },
    });

    const events = [
      f.responseStarted("gpt-4"),
      f.responseWarning("Billing amount is an estimate", WarningCode.BILLING_ESTIMATED),
      f.responseCompleted({
        id: "r",
        output: [],
        replay: [],
        text: "",
        toolCalls: [],
        backend: { adapter: "responses", isSyntheticStream: false },
      }),
    ];

    expect(() => aggregateEvents(events)).not.toThrow();
  });
});

// ── 集成：正常 vs 异常终结 ──────────────────────────────────

describe("Normal vs abnormal termination", () => {
  it("normal: response.completed event completes the response", () => {
    const f = createEventFactory({
      responseId: "normal",
      backend: { kind: "responses", isSynthetic: false },
    });
    const events = [
      f.responseStarted("gpt-4"),
      f.messageStarted("m1"),
      f.messageDelta("m1", "Done"),
      f.messageCompleted(messageItem([textBlock("Done")], { id: "m1" })),
      f.responseCompleted({
        id: "normal",
        output: [messageItem([textBlock("Done")], { id: "m1" })],
        replay: [],
        text: "Done",
        toolCalls: [],
        backend: { adapter: "responses", isSyntheticStream: false },
        stopReason: "end_turn",
      }),
    ];

    const result = aggregateEvents(events);
    expect(result.text).toBe("Done");
    expect(result.stopReason).toBe("end_turn");
  });

  it("abnormal: provider throws -> warning + empty completed", async () => {
    class FailAdapter extends AdapterBase {
      readonly kind = "responses" as const;
      readonly capabilities: AdapterCapabilities = {
        nativeStreaming: false,
        messageStreaming: true,
        reasoningStreaming: false,
        toolCallStreaming: false,
        hiddenReasoningReplay: "none",
        replayFidelity: "low",
        tools: false,
        usage: "none",
        billing: "none",
        providerMetadata: false,
      };
      protected buildRequest(): never {
        throw new Error("Connection refused");
      }
      protected async *runStream(): AsyncIterable<AIStreamEvent> {
        /* unreachable */
      }
    }

    const adapter = new FailAdapter();
    const events: AIStreamEvent[] = [];
    for await (const e of adapter.stream({ model: "gpt-4", requestId: "r", input: [] })) {
      events.push(e);
    }

    const warning = events.find((e) => e.type === "response.warning");
    expect(warning).toBeDefined();
    if (warning?.type === "response.warning") {
      expect(warning.message).toContain("Connection refused");
    }

    const completed = events.find((e) => e.type === "response.completed");
    expect(completed).toBeDefined();
  });
});
