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
  messageItem,
  reasoningItem,
  toolCallItem,
  toolResultItem,
  opaqueItem,
  replayFromOutput,
} from "./mapping.js";

export { AdapterBase } from "./adapter-base.js";
export type { StreamResult } from "./adapter-base.js";
export { syntheticStream } from "./synthetic-stream.js";
export type { SyntheticStreamOptions } from "./synthetic-stream.js";
