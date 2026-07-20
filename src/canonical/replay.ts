/**
 * Replay 与输出文本提取
 */

import type { ContentBlock, InputItem, MessageItem, OutputItem, ReplayItem } from "../types/index.js";

/**
 * 从 output items 构建标准 replay items。
 * 简单场景下 replay 与 output 一致。
 * 复杂场景（需要 opaque continuation）由 adapter 自行扩展。
 */
export function replayFromOutput(output: readonly OutputItem[]): ReplayItem[] {
  return output.map((item): InputItem => {
    switch (item.type) {
      case "message":
      case "reasoning":
      case "tool_call":
      case "server_tool_call":
      case "server_tool_result":
      case "server_tool_discovery":
        return item as InputItem;
      case "opaque":
        return item;
    }
  });
}

/**
 * 从 OutputItem 数组中提取所有 message 类型 item 的文本内容。
 */
export function extractText(output: OutputItem[]): string {
  return output
    .filter((item): item is MessageItem => item.type === "message")
    .flatMap((m) => m.content)
    .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("");
}
