/**
 * Opaque replay 统一协议（入站薄层）
 *
 * 过滤：仅 `source === expectedSource` 且 `purpose === "replay"` 才处理，否则忽略。
 * envelope：object / ≤64KB / depth≤8；失败抛 AIRequestError / INVALID_OPAQUE_REPLAY。
 * 写入 wire 尾部 assistant/model turn 前：先 rollbackTrailing*，再 append（responses 续写 id 除外）。
 * 已知 shape 非法 → 抛 INVALID_OPAQUE_REPLAY；未知 shape → 静默跳过。
 */

import { assertOpaqueReplayEnvelope } from "./security.js";

import type { OpaqueItem } from "../types/index.js";

/**
 * 接受本 adapter 的 opaque replay payload。
 * source/purpose 不匹配返回 null；匹配则 assert envelope 后返回 payload object。
 */
export function acceptOpaqueReplay(
  item: Pick<OpaqueItem, "source" | "purpose" | "payload">,
  expectedSource: string,
): Record<string, unknown> | null {
  if (item.source !== expectedSource || item.purpose !== "replay") {
    return null;
  }
  assertOpaqueReplayEnvelope(item.payload);
  return item.payload as Record<string, unknown>;
}
