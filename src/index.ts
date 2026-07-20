/**
 * @codehz/ai — 统一流式 AI 客户端
 *
 * 对外只暴露一个 canonical 主入口：client.stream()
 *
 * 分层：types → runtime → stream → canonical → provider → adapters
 * 根入口只 re-export 公开面；provider 基础设施为内部模块。
 */

// ── Types ────────────────────────────────────────────────────
export type {
  // kind
  KnownAdapterKind,
  AdapterKind,
  // content
  TextContentBlock,
  JsonContentBlock,
  InstructionBlock,
  ContentBlock,
  // items
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
  // request
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
  // response
  AIResponse,
  StopReason,
  Usage,
  BillingInfo,
  AuxiliaryInfo,
  BackendTrace,
  // events
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
  // adapter protocol / client
  BackendAdapter,
  FetchFn,
  NormalizedRequest,
  CreateAIClientOptions,
  AIClient,
} from "./types/index.js";
export { KNOWN_ADAPTER_KINDS } from "./types/index.js";

// ── Runtime ──────────────────────────────────────────────────
export { createAIClient } from "./runtime/client.js";
export {
  AIError,
  AIRequestError,
  AIProviderError,
  AIStreamError,
  AIMappingError,
  WarningCode,
} from "./runtime/errors.js";

// ── Stream ───────────────────────────────────────────────────
export { collectStream } from "./stream/collect-stream.js";

// ── Canonical constructors ───────────────────────────────────
export {
  mapStopReason,
  mapReasoningVisibility,
  textBlock,
  jsonBlock,
  imageBlock,
  opaqueBlock,
  blockToText,
  contentBlocksToText,
  messageItem,
  reasoningItem,
  toolCallItem,
  toolResultItem,
  opaqueItem,
  serverToolCallItem,
  serverToolResultItem,
  serverToolDiscoveryItem,
  replayFromOutput,
  extractText,
} from "./canonical/index.js";

// ── Portable reasoning level constants (no provider mappers) ─
export { REASONING_LEVELS, REASONING_LEVEL_SET } from "./provider/reasoning.js";

// ── Adapters ─────────────────────────────────────────────────
export {
  ResponsesAdapter,
  MessagesAdapter,
  ChatCompletionsAdapter,
  OllamaAdapter,
  GeminiAdapter,
  MockAdapter,
  assertMockRequest,
  withMockStreaming,
} from "./adapters/index.js";
export type {
  ResponsesAdapterOptions,
  MessagesAdapterOptions,
  ChatCompletionsAdapterOptions,
  OllamaAdapterOptions,
  GeminiAdapterOptions,
  MockAdapterOptions,
  MockHistoryRecord,
  MockTextStreamOptions,
  MockInputExpectation,
  MockRequestExpectation,
  MockHandlerContext,
  MockHandler,
  MockStaticHandler,
  MockWarningStep,
  MockAuxiliaryStep,
  MockMessageStep,
  MockReasoningStep,
  MockToolCallStep,
  MockServerToolCallStep,
  MockServerToolResultStep,
  MockServerToolDiscoveryStep,
  MockOutputStep,
  MockCompleteStep,
  MockErrorStep,
  MockInterruptStep,
  MockThrowStep,
  MockStep,
} from "./adapters/index.js";
