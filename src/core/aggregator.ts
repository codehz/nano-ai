/**
 * 流聚合器
 *
 * 将 AIStreamEvent 序列聚合为统一的 AIResponse。
 * 职责：
 * - 合并 message.delta / reasoning.delta / tool_call.delta
 * - 合并多次 response.auxiliary 补丁
 * - 生成 output / text / toolCalls
 * - 保持 output 顺序稳定
 *
 * 约束：
 * - replay 由 adapter 显式提供，聚合器不猜测
 * - 不伪造 reasoning
 * - 不解释 opaque payload
 */

import type {
  AIStreamEvent,
  AIResponse,
  ContentBlock,
  MessageItem,
  ReasoningItem,
  ToolCallItem,
  OutputItem,
  Usage,
  BillingInfo,
  AuxiliaryInfo,
  BackendTrace,
  StopReason,
} from "../types/index.js";

// ── 内部 pending item 状态 ────────────────────────────────────

interface PendingMessage {
  role: "assistant";
  texts: string[];
}

interface PendingReasoning {
  visibility: ReasoningItem["visibility"];
  blocks: ContentBlock[];
}

interface PendingToolCall {
  name: string;
  argsParts: string[];
}

// ── 聚合器状态 ────────────────────────────────────────────────

interface AggregatorState {
  responseId?: string;
  model?: string;
  backendInfo?: { kind: BackendTrace["adapter"]; isSynthetic: boolean };

  usage?: Usage;
  billing?: BillingInfo;
  auxiliary: AuxiliaryInfo;
  warnings: string[];

  pendingMessages: Map<string, PendingMessage>;
  pendingReasonings: Map<string, PendingReasoning>;
  pendingToolCalls: Map<string, PendingToolCall>;

  /** 已完成 item 的 id 列表，保持输出顺序 */
  outputOrder: string[];
  completedMessages: Map<string, MessageItem>;
  completedReasonings: Map<string, ReasoningItem>;
  completedToolCalls: Map<string, ToolCallItem>;

  /** adapter 在 response.completed 中提供的 replay */
  replayFromAdapter?: import("../types/index.js").ReplayItem[];
  responseIdFromAdapter?: string;
  stopReasonFromAdapter?: StopReason;
  backendFromAdapter?: BackendTrace;
}

function createInitialState(): AggregatorState {
  return {
    pendingMessages: new Map(),
    pendingReasonings: new Map(),
    pendingToolCalls: new Map(),
    outputOrder: [],
    completedMessages: new Map(),
    completedReasonings: new Map(),
    completedToolCalls: new Map(),
    auxiliary: {},
    warnings: [],
  };
}

// ── Event handlers ────────────────────────────────────────────

function handleResponseStarted(
  state: AggregatorState,
  event: AIStreamEvent & { type: "response.started" },
): void {
  state.responseId = event.responseId;
  state.model = event.model;
  state.backendInfo = event.backend;
}

function handleResponseWarning(
  state: AggregatorState,
  event: AIStreamEvent & { type: "response.warning" },
): void {
  state.warnings.push(event.message);
}

function handleResponseAuxiliary(
  state: AggregatorState,
  event: AIStreamEvent & { type: "response.auxiliary" },
): void {
  if (event.usage) {
    state.usage = { ...state.usage, ...event.usage };
  }
  if (event.billing) {
    state.billing = { ...state.billing, ...event.billing };
  }
  if (event.auxiliary) {
    state.auxiliary = { ...state.auxiliary, ...event.auxiliary };
  }
}

function handleMessageStarted(
  state: AggregatorState,
  event: AIStreamEvent & { type: "message.started" },
): void {
  state.pendingMessages.set(event.item.id, {
    role: event.item.role,
    texts: [],
  });
}

function handleMessageDelta(
  state: AggregatorState,
  event: AIStreamEvent & { type: "message.delta" },
): void {
  const pending = state.pendingMessages.get(event.itemId);
  if (pending) {
    pending.texts.push(event.delta.text);
  }
}

function handleMessageCompleted(
  state: AggregatorState,
  event: AIStreamEvent & { type: "message.completed" },
): void {
  const item = event.item;
  const itemId = item.id ?? `msg-${state.outputOrder.length}`;
  state.completedMessages.set(itemId, item);
  state.outputOrder.push(itemId);
  state.pendingMessages.delete(itemId);
}

function handleReasoningStarted(
  state: AggregatorState,
  event: AIStreamEvent & { type: "reasoning.started" },
): void {
  state.pendingReasonings.set(event.item.id, {
    visibility: event.item.visibility,
    blocks: [],
  });
}

function handleReasoningDelta(
  state: AggregatorState,
  event: AIStreamEvent & { type: "reasoning.delta" },
): void {
  const pending = state.pendingReasonings.get(event.itemId);
  if (pending) {
    pending.blocks.push(event.delta);
  }
}

function handleReasoningCompleted(
  state: AggregatorState,
  event: AIStreamEvent & { type: "reasoning.completed" },
): void {
  const item = event.item;
  const stableId = item.id ?? `reason-${state.outputOrder.length}-${Date.now()}`;
  state.completedReasonings.set(stableId, item);
  state.outputOrder.push(stableId);
  state.pendingReasonings.delete(item.id ?? "");
}

function handleToolCallStarted(
  state: AggregatorState,
  event: AIStreamEvent & { type: "tool_call.started" },
): void {
  state.pendingToolCalls.set(event.item.id, {
    name: event.item.name,
    argsParts: [],
  });
}

function handleToolCallDelta(
  state: AggregatorState,
  event: AIStreamEvent & { type: "tool_call.delta" },
): void {
  const pending = state.pendingToolCalls.get(event.itemId);
  if (pending && event.delta.argumentsText) {
    pending.argsParts.push(event.delta.argumentsText);
  }
}

function handleToolCallCompleted(
  state: AggregatorState,
  event: AIStreamEvent & { type: "tool_call.completed" },
): void {
  const item = event.item;
  state.completedToolCalls.set(item.id, item);
  state.outputOrder.push(item.id);
  state.pendingToolCalls.delete(item.id);
}

function handleResponseCompleted(
  state: AggregatorState,
  event: AIStreamEvent & { type: "response.completed" },
): void {
  state.replayFromAdapter = event.response.replay;
  state.responseIdFromAdapter = event.response.id;
  state.stopReasonFromAdapter = event.response.stopReason;
  state.backendFromAdapter = event.response.backend;

  // 从 response.completed 中提取 usage/billing（适配器可能未发 auxiliary 事件）
  if (event.response.usage) {
    state.usage = { ...state.usage, ...event.response.usage };
  }
  if (event.response.billing) {
    state.billing = { ...state.billing, ...event.response.billing };
  }
}

// ── 从聚合状态构建最终 AIResponse ─────────────────────────────

function buildResponse(state: AggregatorState): AIResponse {
  // 按 outputOrder 组装 output
  const output: OutputItem[] = [];
  for (const id of state.outputOrder) {
    const msg = state.completedMessages.get(id);
    if (msg) { output.push(msg); continue; }
    const reason = state.completedReasonings.get(id);
    if (reason) { output.push(reason); continue; }
    const tc = state.completedToolCalls.get(id);
    if (tc) { output.push(tc); continue; }
  }

  // 汇总 text
  const text = output
    .filter((item): item is MessageItem => item.type === "message")
    .flatMap((m) => m.content)
    .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("");

  // toolCalls
  const toolCalls = output.filter(
    (item): item is ToolCallItem => item.type === "tool_call",
  );

  // 合并 backend trace
  const backendFromResponse = state.backendFromAdapter;
  const backend: BackendTrace = {
    adapter: backendFromResponse?.adapter ?? state.backendInfo?.kind ?? "unknown" as BackendTrace["adapter"],
    isSyntheticStream: backendFromResponse?.isSyntheticStream ?? state.backendInfo?.isSynthetic ?? false,
    requestId: backendFromResponse?.requestId ?? state.responseId,
    rawResponseId: backendFromResponse?.rawResponseId,
    metadataSources: backendFromResponse?.metadataSources,
    warnings: backendFromResponse?.warnings,
  };

  return {
    id: state.responseIdFromAdapter ?? state.responseId,
    output,
    replay: state.replayFromAdapter ?? [],
    text,
    toolCalls,
    stopReason: state.stopReasonFromAdapter,
    usage: state.usage,
    billing: state.billing,
    auxiliary: state.auxiliary,
    warnings: state.warnings.length > 0 ? state.warnings : undefined,
    backend,
  };
}

// ── 公开 API ──────────────────────────────────────────────────

/**
 * 将事件数组聚合为 AIResponse。
 * 适用于测试和离线处理场景。
 */
export function aggregateEvents(events: AIStreamEvent[]): AIResponse {
  const state = createInitialState();

  for (const event of events) {
    switch (event.type) {
      case "response.started":
        handleResponseStarted(state, event);
        break;
      case "response.warning":
        handleResponseWarning(state, event);
        break;
      case "response.auxiliary":
        handleResponseAuxiliary(state, event);
        break;
      case "message.started":
        handleMessageStarted(state, event);
        break;
      case "message.delta":
        handleMessageDelta(state, event);
        break;
      case "message.completed":
        handleMessageCompleted(state, event);
        break;
      case "reasoning.started":
        handleReasoningStarted(state, event);
        break;
      case "reasoning.delta":
        handleReasoningDelta(state, event);
        break;
      case "reasoning.completed":
        handleReasoningCompleted(state, event);
        break;
      case "tool_call.started":
        handleToolCallStarted(state, event);
        break;
      case "tool_call.delta":
        handleToolCallDelta(state, event);
        break;
      case "tool_call.completed":
        handleToolCallCompleted(state, event);
        break;
      case "response.completed":
        handleResponseCompleted(state, event);
        break;
    }
  }

  // 用 response.completed 中的 response 做最终构建
  const lastEvent = events[events.length - 1];
  if (!lastEvent || lastEvent.type !== "response.completed") {
    throw new Error(
      "Stream must end with response.completed event to produce a valid AIResponse",
    );
  }

  return buildResponse(state);
}
