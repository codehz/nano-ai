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
  MessageItem,
  ToolCallItem,
  OutputItem,
  Usage,
  BillingInfo,
  AuxiliaryInfo,
  BackendTrace,
  StopReason,
} from "../types/index.js";
import { AIStreamError } from "./errors.js";
import { mergeAuxiliary } from "./merge-auxiliary.js";

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

  /** adapter 在 response.completed 中提供的 replay */
  replayFromAdapter?: import("../types/index.js").ReplayItem[];
  responseIdFromAdapter?: string;
  stopReasonFromAdapter?: StopReason;
  backendFromAdapter?: BackendTrace;
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

function handleMessageCompleted(state: AggregatorState, event: AIStreamEvent & { type: "message.completed" }): void {
  state.output.push(event.item);
  pushMessageText(state, event.item);
}

function handleReasoningCompleted(
  state: AggregatorState,
  event: AIStreamEvent & { type: "reasoning.completed" },
): void {
  state.output.push(event.item);
}

function handleToolCallCompleted(state: AggregatorState, event: AIStreamEvent & { type: "tool_call.completed" }): void {
  state.output.push(event.item);
  state.toolCalls.push(event.item);
}

function handleResponseCompleted(state: AggregatorState, event: AIStreamEvent & { type: "response.completed" }): void {
  state.completed = true;
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
  if (event.response.auxiliary) {
    state.auxiliary = mergeAuxiliary(state.auxiliary, event.response.auxiliary) ?? {};
  }
  if (event.response.warnings) {
    pushWarnings(state, event.response.warnings);
  }
}

// ── 从聚合状态构建最终 AIResponse ─────────────────────────────

function buildResponse(state: AggregatorState): AIResponse {
  // 合并 backend trace
  const backendFromResponse = state.backendFromAdapter;
  const backend: BackendTrace = {
    adapter: backendFromResponse?.adapter ?? state.backendInfo?.kind ?? ("unknown" as BackendTrace["adapter"]),
    isSyntheticStream: backendFromResponse?.isSyntheticStream ?? state.backendInfo?.isSynthetic ?? false,
    requestId: backendFromResponse?.requestId ?? state.responseId,
    rawResponseId: backendFromResponse?.rawResponseId,
    metadataSources: backendFromResponse?.metadataSources,
    warnings: backendFromResponse?.warnings,
  };

  return {
    id: state.responseIdFromAdapter ?? state.responseId,
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
    case "message.delta":
    case "reasoning.started":
    case "reasoning.delta":
    case "tool_call.started":
    case "tool_call.delta":
      break;
    case "message.completed":
      handleMessageCompleted(state, event);
      break;
    case "reasoning.completed":
      handleReasoningCompleted(state, event);
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
  return new AIStreamError(message, "STREAM_ERROR");
}

function pushMessageText(state: AggregatorState, item: MessageItem): void {
  for (const block of item.content) {
    if (block.type === "text") {
      state.textParts.push(block.text);
    }
  }
}
