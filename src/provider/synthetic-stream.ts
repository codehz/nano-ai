/**
 * 模拟流式 (Synthetic Streaming)
 *
 * 将一组已解析的 canonical OutputItem 包装为规范事件流。
 * 适用于非原生流式后端：adapter 拿到完整响应后，调用此函数
 * 即可产出一致的事件序列，无需自己逐事件组装。
 *
 * 约束：
 * - 每个 item 只发一块完整 delta（不模拟逐 token）
 * - 保持 item 边界
 * - 保持后端原始顺序
 * - 不发明 reasoning
 * - 不改写工具参数
 */

import { createEventFactory } from "../stream/event-factory.js";
import { replayFromOutput } from "../canonical/index.js";

import type {
  OutputItem,
  ReplayItem,
  StopReason,
  Usage,
  BillingInfo,
  AIStreamEvent,
  MessageItem,
  ReasoningItem,
  ToolCallItem,
  OpaqueItem,
  AdapterKind,
} from "../types/index.js";

// ── 输入参数 ──────────────────────────────────────────────────

export type SyntheticStreamOptions = {
  model: string;
  responseId: string;
  backend: {
    kind: AdapterKind;
    /** syntheticStream 强制设为 true */
  };
  output: OutputItem[];
  replay?: ReplayItem[];
  stopReason?: StopReason;
  usage?: Usage;
  billing?: BillingInfo;
  providerMetadata?: Record<string, unknown>;
  rawResponseId?: string;
  warnings?: string[];
};

// ── Synthetic Stream ──────────────────────────────────────────

/**
 * 将已解析的 output items 包装为完整规范事件流。
 *
 * 用法示例（在 adapter 的 runStream 中）：
 * ```ts
 * const result = parseNonStreamingResponse(data);
 * yield* syntheticStream({
 *   model: request.model,
 *   responseId: request.requestId,
 *   backend: { kind: "chat-completions" },
 *   output: result.output,
 *   stopReason: result.stopReason,
 *   usage: result.usage,
 * });
 * ```
 */
export async function* syntheticStream(options: SyntheticStreamOptions): AsyncIterable<AIStreamEvent> {
  const {
    model,
    responseId,
    backend,
    output,
    replay,
    stopReason,
    usage,
    billing,
    providerMetadata,
    rawResponseId,
    warnings: extraWarnings,
  } = options;

  const factory = createEventFactory({
    responseId,
    backend: { kind: backend.kind, isSynthetic: true },
  });

  // 1. 响应开始
  yield factory.responseStarted(model);

  // 2. item 级事件 — 每个 item 只发一块完整 delta
  for (const item of output) {
    yield* emitItemEvents(item, factory);
  }

  // 3. auxiliary 事件（如有）
  if (usage || billing) {
    yield factory.responseAuxiliary({ usage, billing });
  }

  // 4. 构建最终 completion 并发射
  const finalReplay = replay ?? replayFromOutput(output);

  // 收集警告
  const allWarnings: string[] = [];
  allWarnings.push("Response is synthetically streamed; delta granularity may differ from native streaming");
  if (extraWarnings) allWarnings.push(...extraWarnings);

  yield factory.responseCompleted({
    replay: finalReplay,
    stopReason,
    usage,
    billing,
    auxiliary: providerMetadata ? { providerMetadata } : undefined,
    opaqueOutput: output.filter((item): item is OpaqueItem => item.type === "opaque"),
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
    trace: {
      requestId: responseId,
      rawResponseId,
      adapter: backend.kind,
      isSyntheticStream: true,
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    },
  });
}

// ── Item 事件发射 ─────────────────────────────────────────────

function* emitItemEvents(item: OutputItem, factory: ReturnType<typeof createEventFactory>): Generator<AIStreamEvent> {
  switch (item.type) {
    case "message":
      yield* emitMessageEvents(item, factory);
      break;
    case "reasoning":
      yield* emitReasoningEvents(item, factory);
      break;
    case "tool_call":
      yield* emitToolCallEvents(item, factory);
      break;
    case "opaque":
      // Opaque items in output have no streaming events
      break;
  }
}

function* emitMessageEvents(
  item: MessageItem,
  factory: ReturnType<typeof createEventFactory>,
): Generator<AIStreamEvent> {
  const id = item.id ?? `syn-msg-${crypto.randomUUID()}`;
  yield factory.messageStarted(id);

  for (const block of item.content) {
    yield factory.messageDelta(id, block);
  }

  yield factory.messageCompleted(id);
}

function* emitReasoningEvents(
  item: ReasoningItem,
  factory: ReturnType<typeof createEventFactory>,
): Generator<AIStreamEvent> {
  const id = item.id ?? `syn-reason-${crypto.randomUUID()}`;
  yield factory.reasoningStarted(id, item.visibility);

  for (const block of item.content) {
    yield factory.reasoningDelta(id, block);
  }

  yield factory.reasoningCompleted(id);
}

function* emitToolCallEvents(
  item: ToolCallItem,
  factory: ReturnType<typeof createEventFactory>,
): Generator<AIStreamEvent> {
  yield factory.toolCallStarted(item.id, item.name);

  if (item.argumentsText) {
    yield factory.toolCallDelta(item.id, { argumentsText: item.argumentsText });
  }

  yield factory.toolCallCompleted(item.id);
}

// ── Helper ────────────────────────────────────────────────────
