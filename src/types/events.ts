/**
 * AIStreamEvent — 统一流事件模型
 *
 * 所有 adapter 都必须产出 AsyncIterable<AIStreamEvent>。
 * 无论后端是否支持原生流式，调用方看到的事件语义都一致：
 *   响应级开始 → item 级开始/增量/完成 → 响应级完成
 */

import type { ContentBlock } from "./content.js";
import type { MessageItem, ReasoningItem, ToolCallItem } from "./items.js";
import type { AIResponse, Usage, BillingInfo, AuxiliaryInfo } from "./response.js";

// ── 事件基类 ──────────────────────────────────────────────────

export type StreamEventBase = {
  type: string;
  responseId?: string;
  sequence: number;
  timestamp: string;
  backend: {
    kind: "chat-completions" | "messages" | "responses" | "ollama" | "mock";
    isSynthetic: boolean;
  };
};

// ── 响应级事件 ────────────────────────────────────────────────

export type ResponseStartedEvent = StreamEventBase & {
  type: "response.started";
  model: string;
};

export type ResponseWarningEvent = StreamEventBase & {
  type: "response.warning";
  message: string;
  code?: string;
};

export type ResponseAuxiliaryEvent = StreamEventBase & {
  type: "response.auxiliary";
  usage?: Usage;
  billing?: BillingInfo;
  auxiliary?: Partial<AuxiliaryInfo>;
};

export type ResponseCompletedEvent = StreamEventBase & {
  type: "response.completed";
  response: AIResponse;
};

// ── 消息流事件 ────────────────────────────────────────────────

export type MessageStartedEvent = StreamEventBase & {
  type: "message.started";
  item: {
    id: string;
    role: "assistant";
  };
};

export type MessageDeltaEvent = StreamEventBase & {
  type: "message.delta";
  itemId: string;
  delta: {
    type: "text";
    text: string;
  };
};

export type MessageCompletedEvent = StreamEventBase & {
  type: "message.completed";
  item: MessageItem;
};

// ── 思维链流事件 ──────────────────────────────────────────────

export type ReasoningStartedEvent = StreamEventBase & {
  type: "reasoning.started";
  item: {
    id: string;
    visibility: "full" | "summary" | "redacted" | "opaque";
  };
};

export type ReasoningDeltaEvent = StreamEventBase & {
  type: "reasoning.delta";
  itemId: string;
  delta: ContentBlock;
};

export type ReasoningCompletedEvent = StreamEventBase & {
  type: "reasoning.completed";
  item: ReasoningItem;
};

// ── 工具调用流事件 ────────────────────────────────────────────

export type ToolCallStartedEvent = StreamEventBase & {
  type: "tool_call.started";
  item: {
    id: string;
    name: string;
  };
};

export type ToolCallDeltaEvent = StreamEventBase & {
  type: "tool_call.delta";
  itemId: string;
  delta: {
    argumentsText?: string;
  };
};

export type ToolCallCompletedEvent = StreamEventBase & {
  type: "tool_call.completed";
  item: ToolCallItem;
};

// ── 统一事件联合 ──────────────────────────────────────────────

export type AIStreamEvent =
  | ResponseStartedEvent
  | ResponseWarningEvent
  | ResponseAuxiliaryEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | ReasoningStartedEvent
  | ReasoningDeltaEvent
  | ReasoningCompletedEvent
  | ToolCallStartedEvent
  | ToolCallDeltaEvent
  | ToolCallCompletedEvent
  | ResponseCompletedEvent;
