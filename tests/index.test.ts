import { describe, it, expect } from "bun:test";

// ── 类型导入验证 ──────────────────────────────────────────────

import {
  // ContentBlock
  type ContentBlock,
  // Items
  type MessageItem,
  type ReasoningItem,
  type ToolCallItem,
  type ToolResultItem,
  type OpaqueItem,
  type InputItem,
  type ReplayItem,
  // Request
  type AIRequest,
  type ToolDefinition,
  type ToolChoice,
  // Response
  type AIResponse,
  type StopReason,
  type Usage,
  type BillingInfo,
  // Events
  type AIStreamEvent,
  // Constants
  CAPABILITY_MATRIX,
  // Client
  createAIClient,
  MockAdapter,
} from "../src/index.js";

// ── ContentBlock ──────────────────────────────────────────────

describe("ContentBlock", () => {
  it("should construct a text block", () => {
    const block: ContentBlock = { type: "text", text: "hello" };
    expect(block.type).toBe("text");
  });

  it("should construct a json block", () => {
    const block: ContentBlock = { type: "json", json: { key: "value" } };
    expect(block.type).toBe("json");
  });

  it("should construct an image block", () => {
    const block: ContentBlock = { type: "image", imageUrl: "https://example.com/img.png" };
    expect(block.type).toBe("image");
  });

  it("should construct a binary_ref block", () => {
    const block: ContentBlock = { type: "binary_ref", ref: "ref-123" };
    expect(block.type).toBe("binary_ref");
  });

  it("should construct an opaque block", () => {
    const block: ContentBlock = { type: "opaque", payload: { raw: true } };
    expect(block.type).toBe("opaque");
  });
});

// ── Items ─────────────────────────────────────────────────────

describe("Items", () => {
  it("should construct a MessageItem", () => {
    const msg: MessageItem = {
      type: "message",
      role: "user",
      content: [{ type: "text", text: "hi" }],
    };
    expect(msg.type).toBe("message");
  });

  it("should construct a ReasoningItem", () => {
    const r: ReasoningItem = {
      type: "reasoning",
      visibility: "full",
      content: [{ type: "text", text: "thinking..." }],
    };
    expect(r.visibility).toBe("full");
  });

  it("should construct a ToolCallItem", () => {
    const tc: ToolCallItem = {
      type: "tool_call",
      id: "call-1",
      name: "get_weather",
      argumentsText: '{"city":"Hangzhou"}',
    };
    expect(tc.name).toBe("get_weather");
  });

  it("should construct a ToolResultItem", () => {
    const tr: ToolResultItem = {
      type: "tool_result",
      callId: "call-1",
      toolName: "get_weather",
      outcome: "success",
      content: [{ type: "json", json: { temp: 28 } }],
    };
    expect(tr.outcome).toBe("success");
  });

  it("should construct an OpaqueItem", () => {
    const op: OpaqueItem = {
      type: "opaque",
      source: "responses",
      purpose: "replay",
      payload: { id: "cont-123" },
    };
    expect(op.purpose).toBe("replay");
  });

  it("should accept ToolResultItem as InputItem but not OutputItem", () => {
    const input: InputItem = {
      type: "tool_result",
      callId: "c1",
      toolName: "t",
      outcome: "success",
      content: [],
    };
    // OutputItem excludes ToolResultItem — compile-time check only
    expect(input.type).toBe("tool_result");
  });

  it("should alias ReplayItem to InputItem", () => {
    const replay: ReplayItem = {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    };
    expect(replay.type).toBe("message");
  });
});

// ── AIRequest ─────────────────────────────────────────────────

describe("AIRequest", () => {
  it("should construct a minimal request", () => {
    const req: AIRequest = {
      input: [{ type: "message", role: "user", content: [{ type: "text", text: "hello" }] }],
    };
    expect(req.input).toHaveLength(1);
  });

  it("should accept instructions as string", () => {
    const req: AIRequest = {
      instructions: "Be helpful.",
      input: [],
    };
    expect(req.instructions).toBe("Be helpful.");
  });

  it("should accept ToolChoice", () => {
    const choice1: ToolChoice = "auto";
    const choice2: ToolChoice = "none";
    const choice3: ToolChoice = { type: "tool", name: "get_weather" };
    expect(choice1).toBe("auto");
    expect(choice2).toBe("none");
    expect(choice3).toEqual({ type: "tool", name: "get_weather" });
  });

  it("should accept ToolDefinition", () => {
    const tool: ToolDefinition = {
      name: "get_weather",
      description: "Get weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    };
    expect(tool.name).toBe("get_weather");
  });
});

// ── AIResponse ────────────────────────────────────────────────

describe("AIResponse", () => {
  it("should construct a minimal response", () => {
    const resp: AIResponse = {
      output: [],
      replay: [],
      text: "",
      toolCalls: [],
      backend: {
        adapter: "responses",
        isSyntheticStream: false,
      },
    };
    expect(resp.text).toBe("");
    expect(resp.backend.adapter).toBe("responses");
  });

  it("should accept StopReason variants", () => {
    const reasons: StopReason[] = ["end_turn", "tool_call", "max_output_tokens", "content_filter", "error", "unknown"];
    expect(reasons).toContain("end_turn");
    expect(reasons).toContain("unknown");
  });

  it("should accept Usage fields", () => {
    const usage: Usage = {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    };
    expect(usage.totalTokens).toBe(30);
  });

  it("should accept BillingInfo", () => {
    const bill: BillingInfo = {
      amount: 0.01,
      currency: "USD",
      isEstimated: false,
      source: "provider",
    };
    expect(bill.isEstimated).toBe(false);
  });
});

// ── Events ────────────────────────────────────────────────────

describe("AIStreamEvent", () => {
  const base = {
    sequence: 0,
    timestamp: "2026-01-01T00:00:00Z",
    backend: { kind: "responses" as const, isSynthetic: false },
  };

  it("should construct response.started", () => {
    const e: AIStreamEvent = { ...base, type: "response.started", model: "gpt-4" };
    expect(e.type).toBe("response.started");
  });

  it("should construct response.completed", () => {
    const e: AIStreamEvent = {
      ...base,
      type: "response.completed",
      response: {
        output: [],
        replay: [],
        text: "",
        toolCalls: [],
        backend: { adapter: "responses", isSyntheticStream: false },
      },
    };
    expect(e.type).toBe("response.completed");
  });

  it("should construct message events", () => {
    const started: AIStreamEvent = { ...base, type: "message.started", item: { id: "m1", role: "assistant" } };
    const delta: AIStreamEvent = { ...base, type: "message.delta", itemId: "m1", delta: { type: "text", text: "Hi" } };
    const completed: AIStreamEvent = {
      ...base,
      type: "message.completed",
      item: { type: "message", role: "assistant", content: [{ type: "text", text: "Hi" }] },
    };
    expect(started.type).toBe("message.started");
    expect(delta.type).toBe("message.delta");
    expect(completed.type).toBe("message.completed");
  });

  it("should construct reasoning events", () => {
    const started: AIStreamEvent = { ...base, type: "reasoning.started", item: { id: "r1", visibility: "full" } };
    const delta: AIStreamEvent = {
      ...base,
      type: "reasoning.delta",
      itemId: "r1",
      delta: { type: "text", text: "..." },
    };
    expect(started.type).toBe("reasoning.started");
    expect(delta.type).toBe("reasoning.delta");
  });

  it("should construct tool_call events", () => {
    const started: AIStreamEvent = { ...base, type: "tool_call.started", item: { id: "tc1", name: "get_weather" } };
    const delta: AIStreamEvent = { ...base, type: "tool_call.delta", itemId: "tc1", delta: { argumentsText: "{}" } };
    expect(started.type).toBe("tool_call.started");
    expect(delta.type).toBe("tool_call.delta");
  });

  it("should construct response.warning", () => {
    const e: AIStreamEvent = { ...base, type: "response.warning", message: "usage missing" };
    expect(e.type).toBe("response.warning");
  });

  it("should construct response.auxiliary", () => {
    const e: AIStreamEvent = { ...base, type: "response.auxiliary", usage: { totalTokens: 10 } };
    expect(e.type).toBe("response.auxiliary");
  });
});

// ── Capability Matrix ─────────────────────────────────────────

describe("CAPABILITY_MATRIX", () => {
  it("should contain all core backends", () => {
    expect(CAPABILITY_MATRIX.responses).toBeDefined();
    expect(CAPABILITY_MATRIX.messages).toBeDefined();
    expect(CAPABILITY_MATRIX["chat.completions"]).toBeDefined();
    expect(CAPABILITY_MATRIX.mock).toBeDefined();
  });

  it("should mark responses as highest capability", () => {
    expect(CAPABILITY_MATRIX.responses.reasoningStreaming).toBe(true);
    expect(CAPABILITY_MATRIX.responses.hiddenReasoningReplay).toBe("full");
    expect(CAPABILITY_MATRIX.responses.replayFidelity).toBe("high");
  });

  it("should mark chat.completions as lowest capability", () => {
    expect(CAPABILITY_MATRIX["chat.completions"].reasoningStreaming).toBe(false);
    expect(CAPABILITY_MATRIX["chat.completions"].hiddenReasoningReplay).toBe("none");
    expect(CAPABILITY_MATRIX["chat.completions"].replayFidelity).toBe("low");
  });

  it("should mark mock as synthetic backend with tool support", () => {
    expect(CAPABILITY_MATRIX.mock.nativeStreaming).toBe(false);
    expect(CAPABILITY_MATRIX.mock.messageStreaming).toBe(true);
    expect(CAPABILITY_MATRIX.mock.toolCallStreaming).toBe(true);
    expect(CAPABILITY_MATRIX.mock.tools).toBe(true);
  });
});

// ── Export sanity ─────────────────────────────────────────────

describe("exports", () => {
  it("should export createAIClient (stub)", () => {
    expect(createAIClient).toBeFunction();
  });

  it("should export MockAdapter", () => {
    expect(MockAdapter).toBeFunction();
  });
});
