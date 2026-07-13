/**
 * 共享工具模块
 *
 * 模块边界：adapter 间共享的映射 helper、adapter 基类、模拟流式、辅助信息采集等。
 */

export {
  mapStopReason,
  mapReasoningVisibility,
  textBlock,
  jsonBlock,
  imageBlock,
  opaqueBlock,
  blockToText,
  contentBlocksToText,
  extractText,
  messageItem,
  reasoningItem,
  toolCallItem,
  toolResultItem,
  opaqueItem,
  replayFromOutput,
} from "./mapping.js";

export { AdapterBase } from "./adapter-base.js";
export type { StreamResult } from "./adapter-base.js";
export { AdapterAuxiliaryState, emitMalformedStreamWarning } from "./adapter-auxiliary.js";
export type { AuxiliaryFinalizeOptions, AuxiliaryFinalizeResult, BillingPostprocessHook } from "./adapter-auxiliary.js";
export { syntheticStream } from "./synthetic-stream.js";
export type { SyntheticStreamOptions } from "./synthetic-stream.js";
export { AuxiliaryCollector } from "./auxiliary-collector.js";
export type { UsageSource, BillingSource, LookupResult } from "./auxiliary-collector.js";
export {
  usageFromAnthropicMessages,
  usageFromChatCompletions,
  usageFromOllama,
  usageFromOpenAIResponses,
} from "./usage-mapping.js";

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
} from "./adapter-security.js";
export type { OpaqueEnvelopeResult } from "./adapter-security.js";

export {
  IncrementalStreamParser,
  splitLines,
  splitSSEFrames,
  parseSseJsonFrame,
  createSseJsonParser,
  parseChatCompletionsDataLine,
  createChatCompletionsSseParser,
  createNdjsonLineParser,
} from "./incremental-stream-parser.js";
export type { StreamSplitResult, StreamParseResult, SseJsonEvent } from "./incremental-stream-parser.js";

export { openProviderJsonStream, iterateProviderStreamBatches, createCompletionGate } from "./provider-stream.js";
export type {
  OpenProviderJsonStreamOptions,
  OpenedProviderStream,
  ProviderStreamBatch,
  ProviderStreamBatchOptions,
} from "./provider-stream.js";

export { NormalizedRequestMapper } from "./request-mapper.js";
