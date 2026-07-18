/**
 * Provider 基础设施（内部）
 *
 * 模块边界：adapter 基类、transport、security、usage/reasoning 映射。
 * 不构成根入口公开 API（Phase 3 将停止从根 re-export）。
 */

export { AdapterBase } from "./base.js";
export type { StreamResult } from "./base.js";
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
export {
  IncrementalStreamParser,
  splitLines,
  splitSSEFrames,
  parseSseJsonFrame,
  createSseJsonParser,
  parseChatCompletionsDataLine,
  createChatCompletionsSseParser,
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
