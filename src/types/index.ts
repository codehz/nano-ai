/**
 * Canonical 类型系统
 *
 * 模块边界：统一请求、事件、响应模型的核心类型定义。
 * 所有公开类型最终从这里导出。
 */

// 基础内容块
export type { ContentBlock } from "./content.js";

// Item 类型体系
export type {
  MessageItem,
  ReasoningItem,
  ToolCallItem,
  ToolResultItem,
  OpaqueItem,
  InputItem,
  OutputItem,
  ReplayItem,
} from "./items.js";

// 请求模型
export type { AIRequest, ToolDefinition, ToolChoice, IncludeSettings } from "./request.js";

// 响应模型
export type { AIResponse, StopReason, Usage, BillingInfo, AuxiliaryInfo, BackendTrace } from "./response.js";

// 流事件模型
export type {
  AIStreamEvent,
  StreamEventBase,
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
} from "./events.js";

// Adapter 协议和 client 类型
export type { BackendAdapter, FetchFn, NormalizedRequest, CreateAIClientOptions, AIClient } from "./adapter.js";
