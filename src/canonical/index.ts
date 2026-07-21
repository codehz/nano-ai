/**
 * Canonical 构造与映射
 *
 * 模块边界：应用与 adapter 共用的 content/item/replay 纯函数。
 */

export { mapStopReason, mapReasoningVisibility } from "./stop-reason.js";
export { textBlock, jsonBlock, imageBlock, opaqueBlock, blockToText, contentBlocksToText } from "./content.js";
export {
  messageItem,
  reasoningItem,
  toolCallItem,
  toolResultItem,
  opaqueItem,
  serverToolCallItem,
  serverToolResultItem,
  serverToolDiscoveryItem,
} from "./items.js";
export { replayFromOutput, extractText } from "./replay.js";
