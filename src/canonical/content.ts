/**
 * Content block 构造与文本提取
 */

import type { ContentBlock } from "../types/index.js";

export function textBlock(text: string): ContentBlock & { type: "text" } {
  return { type: "text", text };
}

export function jsonBlock(json: unknown): ContentBlock & { type: "json" } {
  return { type: "json", json };
}

export function imageBlock(imageUrl: string): ContentBlock & { type: "image" } {
  return { type: "image", imageUrl };
}

export function opaqueBlock(payload: unknown): ContentBlock & { type: "opaque" } {
  return { type: "opaque", payload };
}

/**
 * 将单个 ContentBlock 转为纯文本。
 * text 块直接返回文本，json 块序列化，其余返回空串。
 */
export function blockToText(b: ContentBlock): string {
  if (b.type === "text") return b.text;
  if (b.type === "json") return JSON.stringify(b.json);
  return "";
}

/**
 * 将 ContentBlock 数组拼接为纯文本，块间以换行符分隔。
 */
export function contentBlocksToText(blocks: ContentBlock[]): string {
  return blocks.map(blockToText).join("\n");
}

/**
 * 合并相邻 text content blocks（直接拼接、不插入分隔符）。
 * 非 text block 保留边界。供 aggregator 与 StreamingItemSession 共用。
 */
export function coalesceContentBlocks(blocks: readonly ContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = [];
  for (const block of blocks) {
    const previous = result[result.length - 1];
    if (block.type === "text" && previous?.type === "text") {
      // text 合并路径需要可变副本
      previous.text += block.text;
    } else if (block.type === "text") {
      result.push({ type: "text", text: block.text });
    } else {
      // 非 text 按不可变约定直接引用，避免无意义 spread
      result.push(block);
    }
  }
  return result;
}
