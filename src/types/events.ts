/**
 * AIStreamEvent — 统一流事件模型
 *
 * 所有 adapter 都必须产出 AsyncIterable<AIStreamEvent>。
 * 无论后端是否支持原生流式，调用方看到的事件语义都一致：
 *   响应级开始 → item 级开始/增量/完成 → 响应级完成
 */

import type { ContentBlock } from "./content.js";
import type { Usage, BillingInfo, AuxiliaryInfo, BackendTrace, StopReason } from "./response.js";
import type { Citation, OpaqueItem, ReplayItem, ServerToolDiscoveryItem, ServerToolResultItem } from "./items.js";
import type { AdapterKind } from "./kind.js";

// ── 事件基类 ──────────────────────────────────────────────────

/** 所有流事件共享的顺序、时间和后端信息。 */
export type StreamEventBase = {
  type: string;
  responseId?: string;
  sequence: number;
  timestamp: string;
  backend: {
    kind: AdapterKind;
    isSynthetic: boolean;
  };
};

// ── 响应级事件 ────────────────────────────────────────────────

/** 响应开始事件。 */
export type ResponseStartedEvent = StreamEventBase & {
  type: "response.started";
  model: string;
};

export type { KnownWarningCode, WarningCodeValue, StreamWarning } from "./warning-codes.js";
import type { StreamWarning, WarningCodeValue } from "./warning-codes.js";

/** 非致命响应 warning 事件。 */
export type ResponseWarningEvent = StreamEventBase & {
  type: "response.warning";
  message: string;
  code?: WarningCodeValue;
};

/** 流中的 usage、billing 或 provider 辅助信息事件。 */
export type ResponseAuxiliaryEvent = StreamEventBase & {
  type: "response.auxiliary";
  usage?: Usage;
  billing?: BillingInfo;
  auxiliary?: Partial<AuxiliaryInfo>;
};

/** 响应完成事件；包含 replay 和完成元数据。 */
export type ResponseCompletedEvent = StreamEventBase & {
  type: "response.completed";
  replay: ReplayItem[];
  stopReason?: StopReason;
  usage?: Usage;
  billing?: BillingInfo;
  auxiliary?: AuxiliaryInfo;
  warnings?: StreamWarning[];
  opaqueOutput?: OpaqueItem[];
  trace?: Partial<BackendTrace>;
};

// ── 消息流事件 ────────────────────────────────────────────────

/** 消息 item 开始事件。 */
export type MessageStartedEvent = StreamEventBase & {
  type: "message.started";
  item: {
    id: string;
    role: "assistant";
  };
};

/** 消息内容增量事件。 */
export type MessageDeltaEvent = StreamEventBase & {
  type: "message.delta";
  itemId: string;
  delta: ContentBlock;
};

/** 消息 item 完成事件。 */
export type MessageCompletedEvent = StreamEventBase & {
  type: "message.completed";
  itemId: string;
  citations?: Citation[];
};

// ── 思维链流事件 ──────────────────────────────────────────────

/** reasoning item 开始事件。 */
export type ReasoningStartedEvent = StreamEventBase & {
  type: "reasoning.started";
  item: {
    id: string;
    visibility: "full" | "summary" | "redacted" | "opaque";
  };
};

/** reasoning 内容增量事件。 */
export type ReasoningDeltaEvent = StreamEventBase & {
  type: "reasoning.delta";
  itemId: string;
  delta: ContentBlock;
};

/** reasoning item 完成事件。 */
export type ReasoningCompletedEvent = StreamEventBase & {
  type: "reasoning.completed";
  itemId: string;
};

// ── 工具调用流事件 ────────────────────────────────────────────

/** 客户端工具调用开始事件。 */
export type ToolCallStartedEvent = StreamEventBase & {
  type: "tool_call.started";
  item: {
    id: string;
    name: string;
  };
};

/** 客户端工具调用参数增量事件。 */
export type ToolCallDeltaEvent = StreamEventBase & {
  type: "tool_call.delta";
  itemId: string;
  delta: {
    argumentsText?: string;
  };
};

/** 客户端工具调用完成事件。 */
export type ToolCallCompletedEvent = StreamEventBase & {
  type: "tool_call.completed";
  itemId: string;
};

// ── 服务端工具流事件 ──────────────────────────────────────────

/** Provider 托管工具调用开始事件。 */
export type ServerToolStartedEvent = StreamEventBase & {
  type: "server_tool.started";
  item: {
    id: string;
    tool: string;
    name?: string;
    serverLabel?: string;
  };
};

/** Provider 托管工具调用参数增量事件。 */
export type ServerToolDeltaEvent = StreamEventBase & {
  type: "server_tool.delta";
  itemId: string;
  delta: {
    argumentsText?: string;
  };
};

/** Provider 托管工具调用完成事件。 */
export type ServerToolCompletedEvent = StreamEventBase & {
  type: "server_tool.completed";
  itemId: string;
  status?: "completed" | "failed";
  providerPayload?: unknown;
};

/** Provider 托管工具结果完成事件。 */
export type ServerToolResultCompletedEvent = StreamEventBase & {
  type: "server_tool_result.completed";
  item: ServerToolResultItem;
};

/** Provider 托管工具发现列表完成事件。 */
export type ServerToolDiscoveryCompletedEvent = StreamEventBase & {
  type: "server_tool_discovery.completed";
  item: ServerToolDiscoveryItem;
};

// ── 统一事件联合 ──────────────────────────────────────────────

/** 所有规范化流事件的联合类型。 */
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
  | ServerToolStartedEvent
  | ServerToolDeltaEvent
  | ServerToolCompletedEvent
  | ServerToolResultCompletedEvent
  | ServerToolDiscoveryCompletedEvent
  | ResponseCompletedEvent;
