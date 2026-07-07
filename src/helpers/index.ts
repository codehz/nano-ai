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
  instructionsToText,
  extractText,
  messageItem,
  reasoningItem,
  toolCallItem,
  toolResultItem,
  opaqueItem,
  replayFromOutput,
} from "./mapping.js";

export { parseSSEEvents } from "./sse-parser.js";
export type { SSEEvent } from "./sse-parser.js";

export { AdapterBase } from "./adapter-base.js";
export type { StreamResult } from "./adapter-base.js";
export {
  AdapterAuxiliaryState,
  emitMalformedStreamWarning,
  metadataSourceList,
} from "./adapter-auxiliary.js";
export type { AuxiliaryFinalizeOptions, AuxiliaryFinalizeResult, BillingPostprocessHook } from "./adapter-auxiliary.js";
export { syntheticStream } from "./synthetic-stream.js";
export type { SyntheticStreamOptions } from "./synthetic-stream.js";
export { AuxiliaryCollector } from "./auxiliary-collector.js";
export type { UsageSource, BillingSource, LookupResult } from "./auxiliary-collector.js";
