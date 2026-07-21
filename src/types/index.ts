/**
 * Canonical 类型系统
 *
 * 模块边界：统一请求、事件、响应模型的核心类型定义。
 * 所有公开类型最终从这里导出。
 */

// Adapter kind
export type { KnownAdapterKind, AdapterKind } from "./kind.js";
export { KNOWN_ADAPTER_KINDS } from "./kind.js";

// 基础内容块
export type { TextContentBlock, JsonContentBlock, InstructionBlock, ContentBlock } from "./content.js";

// Item 类型体系
export type {
  Citation,
  UrlCitation,
  ContainerFileCitation,
  MessageItem,
  ReasoningItem,
  ToolCallItem,
  ToolResultItem,
  OpaqueItem,
  ServerToolCallItem,
  ServerToolResultItem,
  ServerToolDiscoveryItem,
  InputItem,
  OutputItem,
  ReplayItem,
} from "./items.js";

// 请求模型
export type {
  AIRequest,
  ToolDefinition,
  ToolChoice,
  IncludeSettings,
  ReasoningLevel,
  ServerToolDefinition,
  WebSearchServerTool,
  CodeExecutionServerTool,
  McpServerTool,
  WebSearchUserLocation,
} from "./request.js";
export { REASONING_LEVELS, REASONING_LEVEL_SET } from "./request.js";

// 响应模型
export type { AIResponse, StopReason, Usage, BillingInfo, AuxiliaryInfo, BackendTrace } from "./response.js";

// Warning 单源
export { WarningCode, streamWarningKey } from "./warning-codes.js";
export type { WarningCodeName, KnownWarningCode, WarningCodeValue, StreamWarning } from "./warning-codes.js";

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
  ServerToolStartedEvent,
  ServerToolDeltaEvent,
  ServerToolCompletedEvent,
  ServerToolResultCompletedEvent,
  ServerToolDiscoveryCompletedEvent,
} from "./events.js";

// Adapter 协议和 client 类型
export type { BackendAdapter, FetchFn, NormalizedRequest, CreateAIClientOptions, AIClient } from "./adapter.js";
