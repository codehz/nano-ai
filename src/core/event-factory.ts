/**
 * 共享事件工厂
 *
 * 负责创建带有统一 sequence / timestamp / responseId / backend 的事件对象。
 * 每个 factory 实例管理一个单调递增的 sequence 计数器。
 */

import type {
  ResponseStartedEvent,
  ResponseWarningEvent,
  ResponseAuxiliaryEvent,
  ResponseCompletedEvent,
  MessageStartedEvent,
  MessageDeltaEvent,
  MessageCompletedEvent,
  ReasoningStartedEvent,
  ReasoningDeltaEvent,
  ReasoningCompletedEvent,
  ToolCallStartedEvent,
  ToolCallDeltaEvent,
  ToolCallCompletedEvent,
  MessageItem,
  ReasoningItem,
  ToolCallItem,
  ContentBlock,
  Usage,
  BillingInfo,
  AuxiliaryInfo,
  AIResponse,
} from "../types/index.js";

export type EventFactoryBackend = {
  kind: "chat-completions" | "messages" | "responses";
  isSynthetic: boolean;
};

export type EventFactoryState = {
  responseId: string;
  backend: EventFactoryBackend;
};

export function createEventFactory(state: EventFactoryState) {
  let seq = 0;

  function next(): number {
    return seq++;
  }

  function timestamp(): string {
    return new Date().toISOString();
  }

  function base(): Pick<ResponseStartedEvent, "responseId" | "sequence" | "timestamp" | "backend"> {
    return {
      responseId: state.responseId,
      sequence: next(),
      timestamp: timestamp(),
      backend: { ...state.backend },
    };
  }

  return {
    // ── 响应级事件 ──────────────────────────────────────────

    responseStarted(model: string): ResponseStartedEvent {
      return { ...base(), type: "response.started", model };
    },

    responseWarning(message: string, code?: string): ResponseWarningEvent {
      return { ...base(), type: "response.warning", message, code };
    },

    responseAuxiliary(data: {
      usage?: Usage;
      billing?: BillingInfo;
      auxiliary?: Partial<AuxiliaryInfo>;
    }): ResponseAuxiliaryEvent {
      return { ...base(), type: "response.auxiliary", ...data };
    },

    responseCompleted(response: AIResponse): ResponseCompletedEvent {
      return { ...base(), type: "response.completed", response };
    },

    // ── 消息流事件 ──────────────────────────────────────────

    messageStarted(id: string): MessageStartedEvent {
      return { ...base(), type: "message.started", item: { id, role: "assistant" } };
    },

    messageDelta(itemId: string, text: string): MessageDeltaEvent {
      return { ...base(), type: "message.delta", itemId, delta: { type: "text", text } };
    },

    messageCompleted(item: MessageItem): MessageCompletedEvent {
      return { ...base(), type: "message.completed", item };
    },

    // ── 思维链流事件 ────────────────────────────────────────

    reasoningStarted(id: string, visibility: ReasoningItem["visibility"]): ReasoningStartedEvent {
      return { ...base(), type: "reasoning.started", item: { id, visibility } };
    },

    reasoningDelta(itemId: string, delta: ContentBlock): ReasoningDeltaEvent {
      return { ...base(), type: "reasoning.delta", itemId, delta };
    },

    reasoningCompleted(item: ReasoningItem): ReasoningCompletedEvent {
      return { ...base(), type: "reasoning.completed", item };
    },

    // ── 工具调用流事件 ──────────────────────────────────────

    toolCallStarted(id: string, name: string): ToolCallStartedEvent {
      return { ...base(), type: "tool_call.started", item: { id, name } };
    },

    toolCallDelta(itemId: string, delta: { argumentsText?: string }): ToolCallDeltaEvent {
      return { ...base(), type: "tool_call.delta", itemId, delta };
    },

    toolCallCompleted(item: ToolCallItem): ToolCallCompletedEvent {
      return { ...base(), type: "tool_call.completed", item };
    },

    /** 返回当前已发出的 sequence 计数（用于断言） */
    get sequence(): number {
      return seq;
    },
  };
}

export type EventFactory = ReturnType<typeof createEventFactory>;
