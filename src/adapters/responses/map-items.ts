/**
 * Responses SSE item 映射与流事件处理器
 *
 * 纯映射可单测；createResponsesSseProcessor 持有流式会话状态。
 */

import { WarningCode } from "../../runtime/errors.js";
import {
  textBlock,
  jsonBlock,
  imageBlock,
  serverToolCallItem,
  serverToolResultItem,
  serverToolDiscoveryItem,
} from "../../canonical/index.js";
import {
  createStreamingItemSession,
  type StreamingItemSession,
} from "../../provider/streaming-item-session.js";
import type {
  AIStreamEvent,
  Citation,
  ContentBlock,
  ReasoningItem,
  ServerToolCallItem,
  ServerToolDiscoveryItem,
  ServerToolResultItem,
} from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import type { ResponsesAPIResponse, ResponsesSSEEvent } from "./types.js";

// ── 已知 SSE 类型 ─────────────────────────────────────────────

/** 已处理或可安全忽略的 Responses SSE 类型（未知类型会 warning 一次）。 */
export const KNOWN_RESPONSES_SSE_TYPES = new Set([
  "response.output_item.added",
  "response.output_item.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.output_text.annotation.added",
  // legacy aliases retained for fixtures / older gateways
  "response.reasoning.delta",
  "response.reasoning.done",
  // current OpenAI reasoning summary + full reasoning text events
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  // server tools
  "response.web_search_call.in_progress",
  "response.web_search_call.searching",
  "response.web_search_call.completed",
  "response.code_interpreter_call.in_progress",
  "response.code_interpreter_call.interpreting",
  "response.code_interpreter_call.completed",
  "response.code_interpreter_call_code.delta",
  "response.code_interpreter_call_code.done",
  "response.mcp_call.in_progress",
  "response.mcp_call.completed",
  "response.mcp_call.failed",
  "response.mcp_call_arguments.delta",
  "response.mcp_call_arguments.done",
  "response.mcp_list_tools.in_progress",
  "response.mcp_list_tools.completed",
  "response.mcp_list_tools.failed",
  "response.content_part.added",
  "response.content_part.done",
  "response.refusal.delta",
  "response.refusal.done",
  "response.in_progress",
  "response.created",
  "response.queued",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
]);

// ── 纯映射 ────────────────────────────────────────────────────

export function mapAnnotationToCitation(annotation: Record<string, unknown>): Citation | undefined {
  if (annotation.type === "url_citation" && typeof annotation.url === "string") {
    return {
      type: "url",
      url: annotation.url,
      ...(typeof annotation.title === "string" ? { title: annotation.title } : {}),
      ...(typeof annotation.start_index === "number" ? { startIndex: annotation.start_index } : {}),
      ...(typeof annotation.end_index === "number" ? { endIndex: annotation.end_index } : {}),
    };
  }

  if (
    annotation.type === "container_file_citation" &&
    typeof annotation.container_id === "string" &&
    typeof annotation.file_id === "string"
  ) {
    return {
      type: "container_file",
      containerId: annotation.container_id,
      fileId: annotation.file_id,
      ...(typeof annotation.filename === "string" ? { filename: annotation.filename } : {}),
      ...(typeof annotation.start_index === "number" ? { startIndex: annotation.start_index } : {}),
      ...(typeof annotation.end_index === "number" ? { endIndex: annotation.end_index } : {}),
    };
  }

  return undefined;
}

export function extractCitationsFromMessageItem(item: Record<string, unknown>): Citation[] {
  const citations: Citation[] = [];
  if (!Array.isArray(item.content)) return citations;
  for (const part of item.content) {
    if (!part || typeof part !== "object") continue;
    const annotations = (part as { annotations?: unknown }).annotations;
    if (!Array.isArray(annotations)) continue;
    for (const annotation of annotations) {
      if (!annotation || typeof annotation !== "object") continue;
      const mapped = mapAnnotationToCitation(annotation as Record<string, unknown>);
      if (mapped) citations.push(mapped);
    }
  }
  return citations;
}

export function webSearchArgumentsText(action: unknown): string | undefined {
  if (!action || typeof action !== "object") return undefined;
  const record = action as Record<string, unknown>;
  if (typeof record.query === "string" && record.query.length > 0) {
    return JSON.stringify({ query: record.query });
  }
  if (Array.isArray(record.queries) && record.queries.every((q) => typeof q === "string")) {
    return JSON.stringify({ queries: record.queries });
  }
  if (record.type === "open_page" && typeof record.url === "string") {
    return JSON.stringify({ url: record.url });
  }
  if (record.type === "find_in_page") {
    return JSON.stringify({
      ...(typeof record.pattern === "string" ? { pattern: record.pattern } : {}),
      ...(typeof record.url === "string" ? { url: record.url } : {}),
    });
  }
  return undefined;
}

export function mapWebSearchCallItem(item: Record<string, unknown>): {
  call: ServerToolCallItem;
  result?: ServerToolResultItem;
} {
  const action = item.action;
  const status = item.status === "failed" ? "failed" : item.status === "completed" ? "completed" : "in_progress";
  const name =
    action && typeof action === "object" && typeof (action as { type?: unknown }).type === "string"
      ? (action as { type: string }).type
      : undefined;
  const call = serverToolCallItem(item.id as string, "web_search", {
    name,
    argumentsText: webSearchArgumentsText(action),
    status,
    providerPayload: {
      ...(action !== undefined ? { action } : {}),
      ...(item.status !== undefined ? { status: item.status } : {}),
    },
  });

  const sources =
    action && typeof action === "object" && Array.isArray((action as { sources?: unknown }).sources)
      ? (action as { sources: unknown[] }).sources
      : undefined;
  if (!sources || sources.length === 0) {
    return { call };
  }

  return {
    call,
    result: serverToolResultItem(
      call.id,
      "web_search",
      status === "failed" ? "error" : "success",
      [jsonBlock({ sources })],
      { providerPayload: { sources } },
    ),
  };
}

export function mapCodeInterpreterOutputs(outputs: unknown): ContentBlock[] {
  if (!Array.isArray(outputs)) return [];
  const blocks: ContentBlock[] = [];
  for (const output of outputs) {
    if (!output || typeof output !== "object") continue;
    const record = output as Record<string, unknown>;
    if (record.type === "logs" && typeof record.logs === "string") {
      blocks.push(textBlock(record.logs));
    } else if (record.type === "image" && typeof record.url === "string") {
      blocks.push(imageBlock(record.url));
    } else {
      blocks.push(jsonBlock(record));
    }
  }
  return blocks;
}

export function mapCodeInterpreterCallItem(item: Record<string, unknown>): {
  call: ServerToolCallItem;
  result?: ServerToolResultItem;
} {
  const status = item.status === "failed" ? "failed" : item.status === "completed" ? "completed" : "in_progress";
  const code = typeof item.code === "string" ? item.code : undefined;
  const call = serverToolCallItem(item.id as string, "code_execution", {
    name: "python",
    argumentsText: code,
    status,
    providerPayload: {
      ...(typeof item.container_id === "string" ? { containerId: item.container_id } : {}),
      ...(item.status !== undefined ? { status: item.status } : {}),
    },
  });

  const content = mapCodeInterpreterOutputs(item.outputs);
  if (content.length === 0 && status !== "failed") {
    return { call };
  }

  return {
    call,
    result: serverToolResultItem(call.id, "code_execution", status === "failed" ? "error" : "success", content, {
      providerPayload: {
        ...(typeof item.container_id === "string" ? { containerId: item.container_id } : {}),
        ...(item.outputs !== undefined ? { outputs: item.outputs } : {}),
      },
    }),
  };
}

export function mapMcpCallItem(item: Record<string, unknown>): {
  call: ServerToolCallItem;
  result: ServerToolResultItem;
} {
  const failed = item.error != null && item.error !== "";
  const call = serverToolCallItem(item.id as string, "mcp", {
    name: typeof item.name === "string" ? item.name : undefined,
    argumentsText: typeof item.arguments === "string" ? item.arguments : undefined,
    serverLabel: typeof item.server_label === "string" ? item.server_label : undefined,
    status: failed ? "failed" : "completed",
    providerPayload: {
      ...(item.approval_request_id !== undefined ? { approvalRequestId: item.approval_request_id } : {}),
      ...(item.error !== undefined ? { error: item.error } : {}),
    },
  });

  const content: ContentBlock[] = [];
  if (typeof item.output === "string" && item.output.length > 0) {
    content.push(textBlock(item.output));
  } else if (item.output !== undefined && item.output !== null) {
    content.push(jsonBlock(item.output));
  }
  if (failed) {
    content.push(
      textBlock(typeof item.error === "string" ? item.error : JSON.stringify(item.error ?? "mcp call failed")),
    );
  }

  return {
    call,
    result: serverToolResultItem(call.id, "mcp", failed ? "error" : "success", content, {
      providerPayload: {
        ...(typeof item.server_label === "string" ? { serverLabel: item.server_label } : {}),
        ...(item.error !== undefined ? { error: item.error } : {}),
      },
    }),
  };
}

export function mapMcpListToolsItem(item: Record<string, unknown>): ServerToolDiscoveryItem {
  const tools: ServerToolDiscoveryItem["tools"] = [];
  if (Array.isArray(item.tools)) {
    for (const tool of item.tools) {
      if (!tool || typeof tool !== "object") continue;
      const record = tool as Record<string, unknown>;
      if (typeof record.name !== "string") continue;
      tools.push({
        name: record.name,
        ...(typeof record.description === "string" ? { description: record.description } : {}),
        ...(record.input_schema !== undefined ? { inputSchema: record.input_schema } : {}),
      });
    }
  }

  return serverToolDiscoveryItem(
    item.id as string,
    typeof item.server_label === "string" ? item.server_label : "unknown",
    tools,
    {
      providerPayload: {
        ...(item.error !== undefined ? { error: item.error } : {}),
        ...(item.tools !== undefined ? { tools: item.tools } : {}),
      },
    },
  );
}

type ReasoningVisibility = ReasoningItem["visibility"];

type ReasoningStreamState = {
  visibility: ReasoningVisibility;
  hasDelta: boolean;
  /** Accumulated final texts from *.done events when deltas were skipped. */
  doneTexts: string[];
  completed: boolean;
};

function createReasoningState(visibility: ReasoningVisibility = "summary"): ReasoningStreamState {
  return { visibility, hasDelta: false, doneTexts: [], completed: false };
}

export function extractReasoningFromOutputItem(item: Record<string, unknown>): {
  text: string;
  visibility: ReasoningVisibility;
} {
  const contentTexts: string[] = [];
  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "reasoning_text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        contentTexts.push((part as { text: string }).text);
      }
    }
  }

  const summaryTexts: string[] = [];
  if (Array.isArray(item.summary)) {
    for (const part of item.summary) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "summary_text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        summaryTexts.push((part as { text: string }).text);
      }
    }
  }

  if (contentTexts.length > 0) {
    return { text: contentTexts.join("\n"), visibility: "full" };
  }
  if (summaryTexts.length > 0) {
    return { text: summaryTexts.join("\n"), visibility: "summary" };
  }
  if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
    return { text: "", visibility: "opaque" };
  }
  return { text: "", visibility: "summary" };
}

function extractFailureMessage(response: ResponsesAPIResponse): string {
  return response.error?.message ?? response.failure?.message ?? "unknown";
}

// ── SSE 处理器 ────────────────────────────────────────────────

export type ResponsesSseProcessor = {
  items: StreamingItemSession;
  getCompletedResponse: () => ResponsesAPIResponse | undefined;
  handleEvent: (sseEvent: ResponsesSSEEvent) => Generator<AIStreamEvent, void, undefined>;
};

export function createResponsesSseProcessor(factory: EventFactory): ResponsesSseProcessor {
  const items = createStreamingItemSession(factory);
  let completedResponse: ResponsesAPIResponse | undefined;
  let unknownEventsWarned = false;
  const messageItemsWithDelta = new Set<string>();
  /** item_id → function name */
  const toolCallNames = new Map<string, string>();
  /** item_id → call_id（canonical ToolCallItem.id / function_call_output.call_id） */
  const toolCallIds = new Map<string, string>();
  /** call_id → already streamed argument deltas */
  const toolCallArgDeltas = new Set<string>();
  const reasoningStates = new Map<string, ReasoningStreamState>();
  /** message item_id → citations accumulated from annotation events / item.done */
  const messageCitations = new Map<string, Citation[]>();
  /** already completed message ids (avoid double message.completed) */
  const completedMessageIds = new Set<string>();
  /** server tool call ids already completed */
  const completedServerToolIds = new Set<string>();
  /** server tool ids that already streamed argument deltas */
  const serverToolArgDeltas = new Set<string>();

  const resolveToolCallId = (itemId: string): string => toolCallIds.get(itemId) ?? itemId;

  const pushCitation = (itemId: string, citation: Citation): void => {
    const list = messageCitations.get(itemId) ?? [];
    list.push(citation);
    messageCitations.set(itemId, list);
  };

  const emitServerToolTerminal = function* (
    call: ServerToolCallItem,
    result?: ServerToolResultItem,
  ): Generator<AIStreamEvent, void, undefined> {
    if (completedServerToolIds.has(call.id)) return;
    completedServerToolIds.add(call.id);

    if (!items.isActive(call.id)) {
      yield items.startServerTool(call.id, call.tool, {
        ...(call.name !== undefined ? { name: call.name } : {}),
        ...(call.serverLabel !== undefined ? { serverLabel: call.serverLabel } : {}),
      });
    }

    // 若未流式吐过 arguments，用 done 载荷补齐（避免与 delta 重复拼接）
    if (call.argumentsText && !serverToolArgDeltas.has(call.id)) {
      yield items.deltaServerTool(call.id, { argumentsText: call.argumentsText });
      serverToolArgDeltas.add(call.id);
    }
    yield items.completeServerTool(call.id, {
      status: call.status === "failed" ? "failed" : "completed",
      providerPayload: call.providerPayload,
    });
    if (result) {
      yield items.completeServerToolResult(result);
    }
  };

  const ensureReasoningState = (
    itemId: string,
    visibility: ReasoningVisibility = "summary",
  ): ReasoningStreamState => {
    let state = reasoningStates.get(itemId);
    if (!state) {
      state = createReasoningState(visibility);
      reasoningStates.set(itemId, state);
    }
    return state;
  };

  const completeReasoning = function* (
    itemId: string,
    text: string,
    visibility: ReasoningVisibility,
  ): Generator<AIStreamEvent, void, undefined> {
    const state = ensureReasoningState(itemId, visibility);
    if (state.completed) return;
    state.completed = true;
    state.visibility = visibility;

    if (!items.isActive(itemId)) {
      const started = items.ensureReasoningStarted(itemId, visibility);
      if (started) yield started;
    }

    if (items.isActive(itemId)) {
      if (!state.hasDelta && text) {
        yield items.deltaReasoning(itemId, textBlock(text));
        state.hasDelta = true;
      }
      yield items.completeReasoning(itemId);
    }
  };

  function* handleEvent(sseEvent: ResponsesSSEEvent): Generator<AIStreamEvent, void, undefined> {
    if (sseEvent.type === "error") {
      const data = sseEvent.data as { message?: string; code?: string };
      yield factory.responseWarning(data.message ?? "Provider error event", data.code);
      return;
    }

    if (sseEvent.type === "response.output_item.added") {
      const item = (sseEvent.data as { item: { id: string; type: string; [key: string]: unknown } }).item;
      switch (item.type) {
        case "message":
          yield items.startMessage(item.id);
          break;
        case "reasoning": {
          // OpenAI 公开流默认是 summary；full/opaque 在后续事件中再收紧。
          const visibility = extractReasoningFromOutputItem(item).visibility;
          ensureReasoningState(item.id, visibility);
          yield items.startReasoning(item.id, visibility);
          break;
        }
        case "function_call": {
          const name = typeof item.name === "string" ? item.name : "unknown";
          // Responses 用 call_id 关联 function_call_output；item.id 是 fc_* item id
          const callId = typeof item.call_id === "string" && item.call_id.length > 0 ? item.call_id : item.id;
          toolCallNames.set(item.id, name);
          toolCallIds.set(item.id, callId);
          yield items.startToolCall(callId, name);
          break;
        }
        case "web_search_call": {
          const action = item.action;
          const name =
            action && typeof action === "object" && typeof (action as { type?: unknown }).type === "string"
              ? (action as { type: string }).type
              : undefined;
          yield items.startServerTool(item.id, "web_search", { name });
          break;
        }
        case "code_interpreter_call": {
          yield items.startServerTool(item.id, "code_execution", { name: "python" });
          break;
        }
        case "mcp_call": {
          yield items.startServerTool(item.id, "mcp", {
            name: typeof item.name === "string" ? item.name : undefined,
            serverLabel: typeof item.server_label === "string" ? item.server_label : undefined,
          });
          break;
        }
        case "mcp_list_tools":
          // discovery 在 done 时原子发射
          break;
        case "mcp_approval_request":
          yield factory.responseWarning(
            `MCP approval requested for tool "${typeof item.name === "string" ? item.name : "unknown"}" on server "${typeof item.server_label === "string" ? item.server_label : "unknown"}"; requireApproval never expected`,
            WarningCode.MCP_APPROVAL_REQUIRED,
          );
          break;
      }
      return;
    }

    if (sseEvent.type === "response.output_item.done") {
      const item = (sseEvent.data as { item: { id: string; type: string; [key: string]: unknown } }).item;
      if (item.type === "reasoning") {
        const extracted = extractReasoningFromOutputItem(item);
        const state = ensureReasoningState(item.id, extracted.visibility);
        const text = extracted.text || (state.doneTexts.length > 0 ? state.doneTexts.join("\n") : "");
        yield* completeReasoning(item.id, text, extracted.visibility || state.visibility);
        return;
      }

      if (item.type === "message") {
        // 晚到的 citations：text.done 可能已 complete message；事件权威下不再回写账本
        for (const citation of extractCitationsFromMessageItem(item)) {
          pushCitation(item.id, citation);
        }
        return;
      }

      if (item.type === "web_search_call") {
        const mapped = mapWebSearchCallItem(item);
        yield* emitServerToolTerminal(mapped.call, mapped.result);
        return;
      }

      if (item.type === "code_interpreter_call") {
        const mapped = mapCodeInterpreterCallItem(item);
        yield* emitServerToolTerminal(mapped.call, mapped.result);
        return;
      }

      if (item.type === "mcp_call") {
        const mapped = mapMcpCallItem(item);
        yield* emitServerToolTerminal(mapped.call, mapped.result);
        return;
      }

      if (item.type === "mcp_list_tools") {
        const discovery = mapMcpListToolsItem(item);
        yield items.completeServerToolDiscovery(discovery);
        return;
      }

      if (item.type === "mcp_approval_request") {
        yield factory.responseWarning(
          `MCP approval request item "${item.id}" completed; approval flow is not supported in MVP`,
          WarningCode.MCP_APPROVAL_REQUIRED,
        );
        return;
      }

      return;
    }

    if (sseEvent.type === "response.output_text.delta") {
      const data = sseEvent.data as { item_id: string; delta: string };
      yield items.deltaMessage(data.item_id, textBlock(data.delta));
      messageItemsWithDelta.add(data.item_id);
      return;
    }

    if (sseEvent.type === "response.output_text.annotation.added") {
      const data = sseEvent.data as {
        item_id?: string;
        annotation?: Record<string, unknown>;
      };
      if (typeof data.item_id === "string" && data.annotation) {
        const citation = mapAnnotationToCitation(data.annotation);
        if (citation) pushCitation(data.item_id, citation);
      }
      return;
    }

    if (sseEvent.type === "response.output_text.done") {
      const data = sseEvent.data as { item_id: string; text: string };
      if (!messageItemsWithDelta.has(data.item_id) && data.text) {
        yield items.deltaMessage(data.item_id, textBlock(data.text));
        messageItemsWithDelta.add(data.item_id);
      }
      if (!completedMessageIds.has(data.item_id) && items.isActive(data.item_id)) {
        completedMessageIds.add(data.item_id);
        const citations = messageCitations.get(data.item_id);
        // 复制数组，避免后续 annotation / item.done 再 push 时污染 snapshot
        const citationsSnapshot = citations && citations.length > 0 ? [...citations] : undefined;
        yield items.completeMessage(
          data.item_id,
          citationsSnapshot ? { citations: citationsSnapshot } : undefined,
        );
      }
      return;
    }

    if (
      sseEvent.type === "response.code_interpreter_call_code.delta" ||
      sseEvent.type === "response.mcp_call_arguments.delta"
    ) {
      const data = sseEvent.data as { item_id: string; delta?: string };
      if (typeof data.item_id === "string" && typeof data.delta === "string" && data.delta.length > 0) {
        serverToolArgDeltas.add(data.item_id);
        yield items.deltaServerTool(data.item_id, { argumentsText: data.delta });
      }
      return;
    }

    if (
      sseEvent.type === "response.code_interpreter_call_code.done" ||
      sseEvent.type === "response.mcp_call_arguments.done"
    ) {
      // 完整 code/args 会在 output_item.done 上写入 call；此处忽略避免重复 delta
      return;
    }

    // server tool progress events — known & ignored (terminal mapping on output_item.done)
    if (
      sseEvent.type === "response.web_search_call.in_progress" ||
      sseEvent.type === "response.web_search_call.searching" ||
      sseEvent.type === "response.web_search_call.completed" ||
      sseEvent.type === "response.code_interpreter_call.in_progress" ||
      sseEvent.type === "response.code_interpreter_call.interpreting" ||
      sseEvent.type === "response.code_interpreter_call.completed" ||
      sseEvent.type === "response.mcp_call.in_progress" ||
      sseEvent.type === "response.mcp_call.completed" ||
      sseEvent.type === "response.mcp_call.failed" ||
      sseEvent.type === "response.mcp_list_tools.in_progress" ||
      sseEvent.type === "response.mcp_list_tools.completed" ||
      sseEvent.type === "response.mcp_list_tools.failed"
    ) {
      return;
    }

    // Modern OpenAI reasoning summary text (publicly streamed for o-series / gpt-5)
    if (sseEvent.type === "response.reasoning_summary_text.delta") {
      const data = sseEvent.data as { item_id: string; delta: string };
      const state = ensureReasoningState(data.item_id, "summary");
      if (state.visibility === "opaque") state.visibility = "summary";
      if (data.delta) {
        state.hasDelta = true;
        yield items.deltaReasoning(data.item_id, textBlock(data.delta));
      }
      return;
    }

    if (sseEvent.type === "response.reasoning_summary_text.done") {
      const data = sseEvent.data as { item_id: string; text: string };
      const state = ensureReasoningState(data.item_id, "summary");
      if (state.visibility === "opaque") state.visibility = "summary";
      if (!state.hasDelta && data.text) {
        state.doneTexts.push(data.text);
        state.hasDelta = true;
        yield items.deltaReasoning(data.item_id, textBlock(data.text));
      } else if (data.text) {
        state.doneTexts.push(data.text);
      }
      return;
    }

    // Full reasoning text (opt-in via include); upgrade visibility to full
    if (sseEvent.type === "response.reasoning_text.delta") {
      const data = sseEvent.data as { item_id: string; delta: string };
      const state = ensureReasoningState(data.item_id, "full");
      state.visibility = "full";
      if (data.delta) {
        state.hasDelta = true;
        yield items.deltaReasoning(data.item_id, textBlock(data.delta));
      }
      return;
    }

    if (sseEvent.type === "response.reasoning_text.done") {
      const data = sseEvent.data as { item_id: string; text: string };
      const state = ensureReasoningState(data.item_id, "full");
      state.visibility = "full";
      if (!state.hasDelta && data.text) {
        state.doneTexts.push(data.text);
        state.hasDelta = true;
        yield items.deltaReasoning(data.item_id, textBlock(data.text));
      } else if (data.text) {
        state.doneTexts.push(data.text);
      }
      return;
    }

    // Structural summary part events — known & ignored (text is handled above)
    if (
      sseEvent.type === "response.reasoning_summary_part.added" ||
      sseEvent.type === "response.reasoning_summary_part.done"
    ) {
      return;
    }

    // Legacy aliases kept for fixtures / older gateways
    if (sseEvent.type === "response.reasoning.delta") {
      const data = sseEvent.data as { item_id: string; delta: string };
      const state = ensureReasoningState(data.item_id, "full");
      state.visibility = "full";
      if (data.delta) {
        state.hasDelta = true;
        yield items.deltaReasoning(data.item_id, textBlock(data.delta));
      }
      return;
    }

    if (sseEvent.type === "response.reasoning.done") {
      const data = sseEvent.data as { item_id: string; text: string };
      const state = ensureReasoningState(data.item_id, "full");
      if (!state.hasDelta && data.text) {
        state.hasDelta = true;
        yield items.deltaReasoning(data.item_id, textBlock(data.text));
      }
      yield* completeReasoning(data.item_id, data.text ?? state.doneTexts.join("\n"), "full");
      return;
    }

    if (sseEvent.type === "response.function_call_arguments.delta") {
      const data = sseEvent.data as { item_id: string; delta: string };
      if (data.delta) {
        const callId = resolveToolCallId(data.item_id);
        toolCallArgDeltas.add(callId);
        yield items.deltaToolCall(callId, { argumentsText: data.delta });
      }
      return;
    }

    if (sseEvent.type === "response.function_call_arguments.done") {
      const data = sseEvent.data as { item_id: string; arguments: string };
      const callId = resolveToolCallId(data.item_id);
      // 若 added 事件缺失，done 时仍尽量从 completed payload 之外兜底 call_id
      if (!toolCallIds.has(data.item_id)) toolCallIds.set(data.item_id, callId);
      const name = toolCallNames.get(data.item_id) ?? "unknown";
      if (!items.isActive(callId)) {
        yield items.startToolCall(callId, name);
      }
      if (!toolCallArgDeltas.has(callId) && data.arguments) {
        yield items.deltaToolCall(callId, { argumentsText: data.arguments });
        toolCallArgDeltas.add(callId);
      }
      if (items.isActive(callId)) {
        yield items.completeToolCall(callId);
      }
      return;
    }

    if (
      sseEvent.type === "response.completed" ||
      sseEvent.type === "response.failed" ||
      sseEvent.type === "response.incomplete"
    ) {
      const data = sseEvent.data as { response: ResponsesAPIResponse };
      if (completedResponse) {
        yield factory.responseWarning("Duplicate finish signal ignored", WarningCode.DUPLICATE_FINISH);
        return;
      }

      completedResponse = data.response;

      // Safety net: finalize any still-open reasoning items from the final response payload.
      if (Array.isArray(data.response.output)) {
        for (const item of data.response.output) {
          if (item?.type !== "reasoning" || !item.id) continue;
          const state = reasoningStates.get(item.id);
          if (state?.completed) continue;
          const extracted = extractReasoningFromOutputItem(item);
          const text = extracted.text || (state && state.doneTexts.length > 0 ? state.doneTexts.join("\n") : "");
          // Only complete if we already tracked this item (session or reasoningStates).
          if (state || items.isActive(item.id)) {
            yield* completeReasoning(item.id, text, extracted.visibility);
          }
        }
      }

      if (sseEvent.type === "response.failed") {
        yield factory.responseWarning(
          `Response failed: ${extractFailureMessage(data.response)}`,
          WarningCode.PROVIDER_FAILURE,
        );
      }
      return;
    }

    if (!KNOWN_RESPONSES_SSE_TYPES.has(sseEvent.type) && !unknownEventsWarned) {
      unknownEventsWarned = true;
      yield factory.responseWarning(
        `Responses API sent unknown event type "${sseEvent.type}"; this may indicate an incomplete integration`,
        WarningCode.UNKNOWN_PROVIDER_EVENT,
      );
    }
  }

  return {
    items,
    getCompletedResponse: () => completedResponse,
    handleEvent,
  };
}
