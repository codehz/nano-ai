/**
 * Provider 基础设施（内部）
 *
 * 模块边界：adapter 基类、transport、security、usage/reasoning 映射。
 * 内部模块：不构成 @codehz/ai 根入口 semver 公开面。
 */

export { AdapterBase } from "./base.js";
export type { StreamResult, StreamCompletedPayload } from "./base.js";
export { HttpAdapterBase } from "./http-adapter.js";
export type { HttpAdapterOptions, HttpAdapterDefaults } from "./http-adapter.js";
export { AdapterAuxiliaryState, emitMalformedStreamWarning } from "./auxiliary.js";
export type { AuxiliaryFinalizeOptions, AuxiliaryFinalizeResult, BillingPostprocessHook } from "./auxiliary.js";
export { syntheticStream } from "./synthetic-stream.js";
export type { SyntheticStreamOptions } from "./synthetic-stream.js";
export { AuxiliaryCollector } from "./auxiliary-collector.js";
export type { UsageSource, BillingSource, LookupResult } from "./auxiliary-collector.js";
export {
  usageFromAnthropicMessages,
  usageFromChatCompletions,
  usageFromGemini,
  usageFromOllama,
  usageFromOpenAIResponses,
} from "./usage/index.js";
export {
  assertOpaqueReplayEnvelope,
  extractProviderErrorMessage,
  measureJsonDepth,
  providerHttpError,
  validateOpaqueReplayEnvelope,
  MAX_OPAQUE_JSON_DEPTH,
  MAX_OPAQUE_PAYLOAD_BYTES,
  PROVIDER_ERROR_MESSAGE_MAX_LEN,
  PROVIDER_ERROR_RAW_BODY_THRESHOLD,
} from "./security.js";
export type { OpaqueEnvelopeResult } from "./security.js";
export { acceptOpaqueReplay } from "./opaque-replay.js";
export {
  IncrementalStreamParser,
  splitLines,
  splitSSEFrames,
  parseSseJsonFrame,
  createSseJsonParser,
  parseDataLineSse,
  parseChatCompletionsDataLine,
  createDataLineSseParser,
  createChatCompletionsSseParser,
  createGeminiSseParser,
  createNdjsonLineParser,
} from "./transport/parser.js";
export type { StreamSplitResult, StreamParseResult, SseJsonEvent } from "./transport/parser.js";
export { openProviderJsonStream, iterateProviderStreamBatches, createCompletionGate } from "./transport/open-stream.js";
export type {
  OpenProviderJsonStreamOptions,
  OpenedProviderStream,
  ProviderStreamBatch,
  ProviderStreamBatchOptions,
} from "./transport/open-stream.js";
export { createProviderJsonStreamSession } from "./transport/run-json-stream.js";
export type {
  ProviderJsonStreamSession,
  ProviderJsonStreamSessionHost,
  ProviderJsonStreamOpenOptions,
  ProviderJsonStreamBatchOptions,
  ProviderJsonStreamCompleteOptions,
} from "./transport/run-json-stream.js";
export { createStreamingItemSession } from "./streaming-item-session.js";
export type { StreamingItemSession } from "./streaming-item-session.js";
export { mergeProviderHeaders, applyExtraBody } from "./request-options.js";
export {
  REASONING_LEVELS,
  REASONING_LEVEL_SET,
  assertSupportedReasoningLevel,
  mapResponsesReasoning,
  mapChatCompletionsReasoningEffort,
  mapMessagesThinkingBudget,
  mapMessagesThinking,
  mapOllamaThink,
  mapGeminiThinking,
} from "./reasoning.js";
export type {
  OpenAIReasoningEffort,
  MessagesThinkingConfig,
  OllamaThinkValue,
  GeminiThinkingLevel,
  GeminiThinkingConfig,
} from "./reasoning.js";
export { NormalizedRequestMapper } from "./request-mapper.js";
