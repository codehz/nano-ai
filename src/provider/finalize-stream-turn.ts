/**
 * 收敛 incomplete / finish 后的 replay + complete 路径。
 * adapter 负责构造 opaque payload；本 helper 负责拼接 replay 并 complete。
 * opaque payload 不在客户端库内截断或施加大小 / 深度限制。
 */

import { replayFromOutput } from "../canonical/index.js";
import type { AIStreamEvent, OpaqueItem, StopReason } from "../types/index.js";
import type { EventFactory } from "../stream/event-factory.js";
import type { StreamingItemSession } from "./streaming-item-session.js";
import type { ProviderJsonStreamCompleteOptions, ProviderJsonStreamSession } from "./transport/run-json-stream.js";

export type FinalizeStreamTurnOptions = {
  opaque?: OpaqueItem | null | undefined;
  stopReason?: StopReason;
  rawResponseId?: string;
  onDuplicate?: ProviderJsonStreamCompleteOptions["onDuplicate"];
  /** Deprecated compatibility option; opaque replay is not size-limited. */
  maxOpaquePayloadBytes?: number;
  /** 超限 omit 时发 warning；强烈建议传入（各 HTTP adapter 均有）。 */
  factory?: Pick<EventFactory, "responseWarning">;
};

/**
 * 从 item session 生成 canonical replay，可选追加 opaque 尾项，再 yield session.complete。
 * 超限 opaque 会被丢弃并 yield `OPAQUE_REPLAY_OMITTED` warning。
 */
export async function* finalizeStreamTurn(
  session: Pick<ProviderJsonStreamSession, "complete">,
  items: StreamingItemSession,
  options: FinalizeStreamTurnOptions = {},
): AsyncIterable<AIStreamEvent> {
  const replay = [...replayFromOutput(items.completedItems())];
  let opaque = options.opaque ?? null;

  if (opaque) {
    replay.push(opaque);
  }

  yield* session.complete(
    {
      replay,
      stopReason: options.stopReason,
      rawResponseId: options.rawResponseId,
    },
    options.onDuplicate !== undefined ? { onDuplicate: options.onDuplicate } : undefined,
  );
}
