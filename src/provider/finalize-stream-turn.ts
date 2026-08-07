/**
 * 收敛 incomplete / finish 后的 replay + complete 路径。
 * adapter 负责构造 opaque payload；本 helper 统一校验体积、拼接 replay 并 complete。
 *
 * emit 与 accept 共用 envelope 上限：超限则省略 opaque（不截断）并打 warning，
 * 避免写出下一轮 accept 必炸的自产毒。
 */

import { replayFromOutput } from "../canonical/index.js";
import { WarningCode } from "../types/warning-codes.js";
import { validateOpaqueReplayEnvelope } from "./security.js";
import type { AIStreamEvent, OpaqueItem, StopReason } from "../types/index.js";
import type { EventFactory } from "../stream/event-factory.js";
import type { StreamingItemSession } from "./streaming-item-session.js";
import type { ProviderJsonStreamCompleteOptions, ProviderJsonStreamSession } from "./transport/run-json-stream.js";

export type FinalizeStreamTurnOptions = {
  opaque?: OpaqueItem | null | undefined;
  stopReason?: StopReason;
  rawResponseId?: string;
  onDuplicate?: ProviderJsonStreamCompleteOptions["onDuplicate"];
  /** 出站 opaque 体积校验；与 accept 同限。省略则用默认 1 MiB。 */
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
    const check = validateOpaqueReplayEnvelope(opaque.payload, {
      maxBytes: options.maxOpaquePayloadBytes,
    });
    if (!check.ok) {
      if (options.factory) {
        yield options.factory.responseWarning(
          `Omitted opaque replay payload: ${check.reason}`,
          WarningCode.OPAQUE_REPLAY_OMITTED,
        );
      }
      opaque = null;
    }
  }

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
