/**
 * 收敛 incomplete / finish 后的 replay + complete 路径。
 * adapter 负责构造 opaque payload；本 helper 统一拼接 replay 并 complete。
 */

import { replayFromOutput } from "../canonical/index.js";
import type { AIStreamEvent, OpaqueItem, StopReason } from "../types/index.js";
import type { StreamingItemSession } from "./streaming-item-session.js";
import type {
  ProviderJsonStreamCompleteOptions,
  ProviderJsonStreamSession,
} from "./transport/run-json-stream.js";

export type FinalizeStreamTurnOptions = {
  opaque?: OpaqueItem | null | undefined;
  stopReason?: StopReason;
  rawResponseId?: string;
  onDuplicate?: ProviderJsonStreamCompleteOptions["onDuplicate"];
};

/**
 * 从 item session 生成 canonical replay，可选追加 opaque 尾项，再 yield session.complete。
 */
export async function* finalizeStreamTurn(
  session: Pick<ProviderJsonStreamSession, "complete">,
  items: StreamingItemSession,
  options: FinalizeStreamTurnOptions = {},
): AsyncIterable<AIStreamEvent> {
  const replay = [...replayFromOutput(items.completedItems())];
  if (options.opaque) {
    replay.push(options.opaque);
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
