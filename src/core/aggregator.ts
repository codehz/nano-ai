/**
 * 流聚合器
 *
 * 将 AIStreamEvent 序列聚合为统一的 AIResponse。
 *
 * 职责：
 * - 严格 item 状态机：started 创建 active item，delta 累积，completed 构建 OutputItem
 * - 校验：未 started 的 delta/completed、ID 重用、类型错配、response.completed 时 active items 非空
 * - 响应级 sequence/responseId/started/completed 校验
 * - usage/billing/auxiliary 仅来自 response.auxiliary
 * - warning 仅来自 response.warning
 * - 最终 AIResponse 由聚合器唯一构建
 *
 * 约束：
 * - replay 由 adapter 显式提供，聚合器不猜测
 * - 不伪造 reasoning
 * - 不解释 opaque payload
 */

import type {
  AIStreamEvent,
  AIResponse,
  MessageItem,
  ToolCallItem,
  OutputItem,
  Usage,
  BillingInfo,
  AuxiliaryInfo,
  BackendTrace,
  StopReason,
  ContentBlock,
} from "../types/index.js";
import { AIStreamError } from "./errors.js";
import { mergeAuxiliary } from "./merge-auxiliary.js";

// ── Active item types ─────────────────────────────────────────

type ActiveMessage = {
  type: "message";
  id: string;
  role: "assistant";
  content: ContentBlock[];
};

type ActiveReasoning = {
  type: "reasoning";
  id: string;
  visibility: "full" | "summary" | "redacted" | "opaque";
  content: ContentBlock[];
};

type ActiveToolCall = {
  type: "tool_call";
  id: string;
  name: string;
  argumentsText: string;
};

type ActiveItem = ActiveMessage | ActiveReasoning | ActiveToolCall;

// ── 聚合器状态 ────────────────────────────────────────────────

export interface AggregatorState {
  responseId?: string;
  model?: string;
  backendInfo?: { kind: BackendTrace["adapter"]; isSynthetic: boolean };

  usage?: Usage;
  billing?: BillingInfo;
  auxiliary: AuxiliaryInfo;
  warnings: string[];
  warningSet: Set<string>;
  output: OutputItem[];
  textParts: string[];
  toolCalls: ToolCallItem[];
  lastEventType?: AIStreamEvent["type"];
  started: boolean;
  completed: boolean;
  nextSequence?: number;
  activeItems: Map<string, ActiveItem>;

  /** adapter 在 response.completed 中提供的 replay */
  replayFromAdapter?: import("../types/index.js").ReplayItem[];
  stopReasonFromAdapter?: StopReason;
  backendFromAdapter?: Partial<BackendTrace>;
}

export function createAggregatorState(): AggregatorState {
  return {
    auxiliary: {},
    warnings: [],
    warningSet: new Set(),
    output: [],
    textParts: [],
    toolCalls: [],
    started: false,
    completed: false,
    activeItems: new Map(),
  };
}

// ── Active item helpers ───────────────────────────────────────

function getActiveItem(state: AggregatorState, itemId: string, expectedType: ActiveItem["type"]): ActiveItem {
  const item = state.activeItems.get(itemId);
  if (!item) {
    throw streamProtocolError(`Received ${expectedType} delta/completed for unknown item: ${itemId}`);
  }
  if (item.type !== expectedType) {
    throw streamProtocolError(`Item ${itemId} started as ${item.type} but received ${expectedType} event`);
  }
  return item;
}

function finalizeMessage(active: ActiveMessage): MessageItem {
  return {
    type: "message",
    id: active.id,
    role: active.role,
    content: active.content,
  };
}

function finalizeReasoning(active: ActiveReasoning): import("../types/index.js").ReasoningItem {
  return {
    type: "reasoning",
    id: active.id,
    visibility: active.visibility,
    content: active.content,
  };
}

function finalizeToolCall(active: ActiveToolCall): ToolCallItem {
  return {
    type: "tool_call",
    id: active.id,
    name: active.name,
    argumentsText: active.argumentsText,
  };
}

// ── Event handlers ────────────────────────────────────────────

function handleResponseStarted(state: AggregatorState, event: AIStreamEvent & { type: "response.started" }): void {
  if (state.started) {
    throw streamProtocolError("Stream must contain exactly one response.started event");
  }
  state.started = true;
  state.responseId = event.responseId;
  state.model = event.model;
  state.backendInfo = event.backend;
}

function handleResponseWarning(state: AggregatorState, event: AIStreamEvent & { type: "response.warning" }): void {
  pushWarnings(state, [event.message]);
}

function handleResponseAuxiliary(state: AggregatorState, event: AIStreamEvent & { type: "response.auxiliary" }): void {
  if (event.usage) {
    state.usage = { ...state.usage, ...event.usage };
  }
  if (event.billing) {
    state.billing = { ...state.billing, ...event.billing };
  }
  if (event.auxiliary) {
    state.auxiliary = mergeAuxiliary(state.auxiliary, event.auxiliary) ?? {};
  }
}

function handleMessageStarted(state: AggregatorState, event: AIStreamEvent & { type: "message.started" }): void {
  const id = event.item.id;
  if (state.activeItems.has(id)) {
    throw streamProtocolError(`Item with id ${id} is already active`);
  }
  state.activeItems.set(id, {
    type: "message",
    id,
    role: event.item.role,
    content: [],
  });
}

function handleMessageDelta(state: AggregatorState, event: AIStreamEvent & { type: "message.delta" }): void {
  const active = getActiveItem(state, event.itemId, "message") as ActiveMessage;
  active.content.push(event.delta);
}

function handleMessageCompleted(state: AggregatorState, event: AIStreamEvent & { type: "message.completed" }): void {
  const active = getActiveItem(state, event.itemId, "message") as ActiveMessage;
  state.activeItems.delete(event.itemId);
  const item = finalizeMessage(active);
  state.output.push(item);
  pushMessageText(state, item);
}

function handleReasoningStarted(state: AggregatorState, event: AIStreamEvent & { type: "reasoning.started" }): void {
  const id = event.item.id;
  if (state.activeItems.has(id)) {
    throw streamProtocolError(`Item with id ${id} is already active`);
  }
  state.activeItems.set(id, {
    type: "reasoning",
    id,
    visibility: event.item.visibility,
    content: [],
  });
}

function handleReasoningDelta(state: AggregatorState, event: AIStreamEvent & { type: "reasoning.delta" }): void {
  const active = getActiveItem(state, event.itemId, "reasoning") as ActiveReasoning;
  active.content.push(event.delta);
}

function handleReasoningCompleted(
  state: AggregatorState,
  event: AIStreamEvent & { type: "reasoning.completed" },
): void {
  const active = getActiveItem(state, event.itemId, "reasoning") as ActiveReasoning;
  state.activeItems.delete(event.itemId);
  state.output.push(finalizeReasoning(active));
}

function handleToolCallStarted(state: AggregatorState, event: AIStreamEvent & { type: "tool_call.started" }): void {
  const id = event.item.id;
  if (state.activeItems.has(id)) {
    throw streamProtocolError(`Item with id ${id} is already active`);
  }
  state.activeItems.set(id, {
    type: "tool_call",
    id,
    name: event.item.name,
    argumentsText: "",
  });
}

function handleToolCallDelta(state: AggregatorState, event: AIStreamEvent & { type: "tool_call.delta" }): void {
  const active = getActiveItem(state, event.itemId, "tool_call") as ActiveToolCall;
  if (event.delta.argumentsText) {
    active.argumentsText += event.delta.argumentsText;
  }
}

function handleToolCallCompleted(state: AggregatorState, event: AIStreamEvent & { type: "tool_call.completed" }): void {
  const active = getActiveItem(state, event.itemId, "tool_call") as ActiveToolCall;
  state.activeItems.delete(event.itemId);
  const item = finalizeToolCall(active);
  state.output.push(item);
  state.toolCalls.push(item);
}

function handleResponseCompleted(state: AggregatorState, event: AIStreamEvent & { type: "response.completed" }): void {
  if (state.activeItems.size > 0) {
    throw streamProtocolError("response.completed received while active items still pending");
  }
  state.completed = true;
  state.replayFromAdapter = event.replay;
  state.stopReasonFromAdapter = event.stopReason;
  state.backendFromAdapter = event.trace;
  if (event.usage) state.usage = { ...state.usage, ...event.usage };
  if (event.billing) state.billing = { ...state.billing, ...event.billing };
  if (event.auxiliary) state.auxiliary = mergeAuxiliary(state.auxiliary, event.auxiliary) ?? {};
  if (event.warnings) pushWarnings(state, event.warnings);
  if (event.opaqueOutput) state.output.push(...event.opaqueOutput);
}

// ── 从聚合状态构建最终 AIResponse ─────────────────────────────

function buildResponse(state: AggregatorState): AIResponse {
  const backendFromCompleted = state.backendFromAdapter;
  const backend: BackendTrace = {
    adapter: backendFromCompleted?.adapter ?? state.backendInfo?.kind ?? ("unknown" as BackendTrace["adapter"]),
    isSyntheticStream: backendFromCompleted?.isSyntheticStream ?? state.backendInfo?.isSynthetic ?? false,
    requestId: backendFromCompleted?.requestId ?? state.responseId,
    rawResponseId: backendFromCompleted?.rawResponseId,
    metadataSources: backendFromCompleted?.metadataSources,
    warnings: backendFromCompleted?.warnings,
  };

  return {
    id: state.responseId,
    output: state.output,
    replay: state.replayFromAdapter ?? [],
    text: state.textParts.join(""),
    toolCalls: state.toolCalls,
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
export function aggregateEvents(events: readonly AIStreamEvent[]): AIResponse {
  const state = createAggregatorState();
  for (const event of events) {
    aggregateEvent(state, event);
  }
  return finalizeAggregation(state);
}

export function aggregateEvent(state: AggregatorState, event: AIStreamEvent): void {
  validateEventEnvelope(state, event);
  state.lastEventType = event.type;

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

export function finalizeAggregation(state: AggregatorState): AIResponse {
  if (!state.started) {
    throw streamProtocolError("Stream must start with response.started event");
  }
  if (!state.completed || state.lastEventType !== "response.completed") {
    throw streamProtocolError("Stream must end with response.completed event to produce a valid AIResponse");
  }

  return buildResponse(state);
}

function pushWarnings(state: AggregatorState, warnings: readonly string[]): void {
  for (const warning of warnings) {
    if (!state.warningSet.has(warning)) {
      state.warningSet.add(warning);
      state.warnings.push(warning);
    }
  }
}

function pushMessageText(state: AggregatorState, item: MessageItem): void {
  for (const block of item.content) {
    if (block.type === "text") {
      state.textParts.push(block.text);
    }
  }
}

function validateEventEnvelope(state: AggregatorState, event: AIStreamEvent): void {
  if (state.completed) {
    throw streamProtocolError("response.completed must be the final stream event");
  }
  if (!state.started && event.type !== "response.started") {
    throw streamProtocolError("Stream must start with response.started event");
  }
  if (state.responseId !== undefined && event.responseId !== state.responseId) {
    throw streamProtocolError("All stream events must use the same responseId");
  }
  if (state.nextSequence !== undefined && event.sequence !== state.nextSequence) {
    throw streamProtocolError(`Expected event sequence ${state.nextSequence}, received ${event.sequence}`);
  }
  state.nextSequence = event.sequence + 1;
}

function streamProtocolError(message: string): AIStreamError {
  return new AIStreamError(message, "STREAM_PROTOCOL_ERROR");
}
