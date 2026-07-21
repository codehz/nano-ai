/**
 * AIStreamEvent — 统一流事件模型
 *
 * 所有 adapter 都必须产出 AsyncIterable<AIStreamEvent>。
 * 无论后端是否支持原生流式，调用方看到的事件语义都一致：
 *   响应级开始 → item 级开始/增量/完成 → 响应级完成
 */

import type { ContentBlock } from "./content.js";
import type { Usage, BillingInfo, AuxiliaryInfo, BackendTrace, StopReason } from "./response.js";
import type {
  Citation,
  OpaqueItem,
  ReplayItem,
  ServerToolDiscoveryItem,
  ServerToolResultItem,
} from "./items.js";
import type { AdapterKind } from "./kind.js";

// ── 事件基类 ──────────────────────────────────────────────────

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

export type ResponseStartedEvent = StreamEventBase & {
  type: "response.started";
  model: string;
};

/**
 * 已知 warning 码字面量（与 runtime WarningCode 值对齐）。
 * types 层不依赖 runtime，故在此维护联合；扩展自定义码用 `string & {}`。
 */
export type KnownWarningCode =
  | "REPLAY_FIDELITY_LOW"
  | "USAGE_MISSING"
  | "BILLING_MISSING"
  | "BILLING_ESTIMATED"
  | "LOOKUP_FAILED"
  | "LOOKUP_TIMEOUT"
  | "STREAM_INCOMPLETE"
  | "CAPABILITY_DOWNGRADE"
  | "SYNTHETIC_STREAM"
  | "TOOL_CALL_BATCHED"
  | "MAPPING_ERROR"
  | "UNSUPPORTED_METADATA"
  | "DUPLICATE_FINISH"
  | "UNKNOWN_PROVIDER_EVENT"
  | "CONTENT_FILTER"
  | "MULTIPLE_CHOICES_IGNORED"
  | "MCP_APPROVAL_REQUIRED"
  | "PROVIDER_FAILURE";

export type WarningCodeValue = KnownWarningCode | (string & {});

export type ResponseWarningEvent = StreamEventBase & {
  type: "response.warning";
  message: string;
  code?: WarningCodeValue;
};

export type ResponseAuxiliaryEvent = StreamEventBase & {
  type: "response.auxiliary";
  usage?: Usage;
  billing?: BillingInfo;
  auxiliary?: Partial<AuxiliaryInfo>;
};

export type ResponseCompletedEvent = StreamEventBase & {
  type: "response.completed";
  replay: ReplayItem[];
  stopReason?: StopReason;
  usage?: Usage;
  billing?: BillingInfo;
  auxiliary?: AuxiliaryInfo;
  warnings?: string[];
  opaqueOutput?: OpaqueItem[];
  trace?: Partial<BackendTrace>;
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
  delta: ContentBlock;
};

export type MessageCompletedEvent = StreamEventBase & {
  type: "message.completed";
  itemId: string;
  citations?: Citation[];
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
  itemId: string;
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
  itemId: string;
};

// ── 服务端工具流事件 ──────────────────────────────────────────

export type ServerToolStartedEvent = StreamEventBase & {
  type: "server_tool.started";
  item: {
    id: string;
    tool: string;
    name?: string;
    serverLabel?: string;
  };
};

export type ServerToolDeltaEvent = StreamEventBase & {
  type: "server_tool.delta";
  itemId: string;
  delta: {
    argumentsText?: string;
  };
};

export type ServerToolCompletedEvent = StreamEventBase & {
  type: "server_tool.completed";
  itemId: string;
  status?: "completed" | "failed";
  providerPayload?: unknown;
};

export type ServerToolResultCompletedEvent = StreamEventBase & {
  type: "server_tool_result.completed";
  item: ServerToolResultItem;
};

export type ServerToolDiscoveryCompletedEvent = StreamEventBase & {
  type: "server_tool_discovery.completed";
  item: ServerToolDiscoveryItem;
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
  | ServerToolStartedEvent
  | ServerToolDeltaEvent
  | ServerToolCompletedEvent
  | ServerToolResultCompletedEvent
  | ServerToolDiscoveryCompletedEvent
  | ResponseCompletedEvent;
