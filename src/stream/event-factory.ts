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
  ServerToolStartedEvent,
  ServerToolDeltaEvent,
  ServerToolCompletedEvent,
  ServerToolResultCompletedEvent,
  ServerToolDiscoveryCompletedEvent,
  ContentBlock,
  Citation,
  Usage,
  BillingInfo,
  AuxiliaryInfo,
  ReplayItem,
  StopReason,
  BackendTrace,
  OpaqueItem,
  ReasoningItem,
  AdapterKind,
  ServerToolResultItem,
  ServerToolDiscoveryItem,
  WarningCodeValue,
} from "../types/index.js";

export type EventFactoryBackend = {
  kind: AdapterKind;
  isSynthetic: boolean;
};

export type EventFactoryState = {
  responseId: string;
  backend: EventFactoryBackend;
};

function timestamp(): string {
  return new Date().toISOString();
}

export function createEventFactory(state: EventFactoryState) {
  let seq = 0;
  const warnings: string[] = [];

  function next(): number {
    return seq++;
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

    responseWarning(message: string, code?: WarningCodeValue): ResponseWarningEvent {
      warnings.push(message);
      return { ...base(), type: "response.warning", message, code };
    },

    responseAuxiliary(data: {
      usage?: Usage;
      billing?: BillingInfo;
      auxiliary?: Partial<AuxiliaryInfo>;
    }): ResponseAuxiliaryEvent {
      return { ...base(), type: "response.auxiliary", ...data };
    },

    responseCompleted(completion: {
      replay: ReplayItem[];
      stopReason?: StopReason;
      usage?: Usage;
      billing?: BillingInfo;
      auxiliary?: AuxiliaryInfo;
      warnings?: string[];
      opaqueOutput?: OpaqueItem[];
      trace?: Partial<BackendTrace>;
    }): ResponseCompletedEvent {
      return { ...base(), type: "response.completed", ...completion };
    },

    // ── 消息流事件 ──────────────────────────────────────────

    messageStarted(id: string): MessageStartedEvent {
      return { ...base(), type: "message.started", item: { id, role: "assistant" } };
    },

    messageDelta(itemId: string, delta: ContentBlock): MessageDeltaEvent {
      return { ...base(), type: "message.delta", itemId, delta };
    },

    messageCompleted(itemId: string, options?: { citations?: Citation[] }): MessageCompletedEvent {
      return {
        ...base(),
        type: "message.completed",
        itemId,
        ...(options?.citations ? { citations: options.citations } : {}),
      };
    },

    // ── 思维链流事件 ────────────────────────────────────────

    reasoningStarted(id: string, visibility: ReasoningItem["visibility"]): ReasoningStartedEvent {
      return { ...base(), type: "reasoning.started", item: { id, visibility } };
    },

    reasoningDelta(itemId: string, delta: ContentBlock): ReasoningDeltaEvent {
      return { ...base(), type: "reasoning.delta", itemId, delta };
    },

    reasoningCompleted(itemId: string): ReasoningCompletedEvent {
      return { ...base(), type: "reasoning.completed", itemId };
    },

    // ── 客户端工具调用流事件 ────────────────────────────────

    toolCallStarted(id: string, name: string): ToolCallStartedEvent {
      return { ...base(), type: "tool_call.started", item: { id, name } };
    },

    toolCallDelta(itemId: string, delta: { argumentsText?: string }): ToolCallDeltaEvent {
      return { ...base(), type: "tool_call.delta", itemId, delta };
    },

    toolCallCompleted(itemId: string): ToolCallCompletedEvent {
      return { ...base(), type: "tool_call.completed", itemId };
    },

    // ── 服务端工具流事件 ────────────────────────────────────

    serverToolStarted(
      id: string,
      tool: string,
      options?: { name?: string; serverLabel?: string },
    ): ServerToolStartedEvent {
      return {
        ...base(),
        type: "server_tool.started",
        item: {
          id,
          tool,
          ...(options?.name !== undefined ? { name: options.name } : {}),
          ...(options?.serverLabel !== undefined ? { serverLabel: options.serverLabel } : {}),
        },
      };
    },

    serverToolDelta(itemId: string, delta: { argumentsText?: string }): ServerToolDeltaEvent {
      return { ...base(), type: "server_tool.delta", itemId, delta };
    },

    serverToolCompleted(
      itemId: string,
      options?: { status?: "completed" | "failed"; providerPayload?: unknown },
    ): ServerToolCompletedEvent {
      return {
        ...base(),
        type: "server_tool.completed",
        itemId,
        ...(options?.status ? { status: options.status } : {}),
        ...(options?.providerPayload !== undefined ? { providerPayload: options.providerPayload } : {}),
      };
    },

    serverToolResultCompleted(item: ServerToolResultItem): ServerToolResultCompletedEvent {
      return { ...base(), type: "server_tool_result.completed", item };
    },

    serverToolDiscoveryCompleted(item: ServerToolDiscoveryItem): ServerToolDiscoveryCompletedEvent {
      return { ...base(), type: "server_tool_discovery.completed", item };
    },

    /** 返回当前已发出的 sequence 计数（用于断言） */
    get sequence(): number {
      return seq;
    },

    /** 返回当前已记录的 warning 副本。 */
    get warnings(): string[] {
      return [...warnings];
    },
  };
}

export type EventFactory = ReturnType<typeof createEventFactory>;
