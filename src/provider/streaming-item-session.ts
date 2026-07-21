/**
 * StreamingItemSession — item 级 start/delta/complete 唯一状态机
 *
 * 方案 A（事件权威）：
 * - 事件由本 session 通过 EventFactory 产出
 * - completedItems 与已完成事件同源，仅供 replayFromOutput
 * - 禁止 adapter 再维护并行 OutputItem[] 内容账本
 */

import {
  coalesceContentBlocks,
  messageItem,
  reasoningItem,
  toolCallItem,
  serverToolCallItem,
} from "../canonical/index.js";
import { AIStreamError } from "../runtime/errors.js";
import type { EventFactory } from "../stream/event-factory.js";
import type {
  AIStreamEvent,
  Citation,
  ContentBlock,
  OutputItem,
  ReasoningItem,
  ServerToolDiscoveryItem,
  ServerToolResultItem,
} from "../types/index.js";

// ── Active state ──────────────────────────────────────────────

type ActiveMessage = {
  type: "message";
  id: string;
  content: ContentBlock[];
  citations?: Citation[];
};

type ActiveReasoning = {
  type: "reasoning";
  id: string;
  visibility: ReasoningItem["visibility"];
  content: ContentBlock[];
};

type ActiveToolCall = {
  type: "tool_call";
  id: string;
  name: string;
  argumentChunks: string[];
};

type ActiveServerToolCall = {
  type: "server_tool_call";
  id: string;
  tool: string;
  name?: string;
  argumentChunks: string[];
  serverLabel?: string;
  status?: "in_progress" | "completed" | "failed";
  providerPayload?: unknown;
};

type ActiveItem = ActiveMessage | ActiveReasoning | ActiveToolCall | ActiveServerToolCall;

function protocolError(message: string): AIStreamError {
  return new AIStreamError(message, "STREAM_PROTOCOL_ERROR");
}

// ── Session ───────────────────────────────────────────────────

export type StreamingItemSession = {
  startMessage(id: string): AIStreamEvent;
  /** 若未 start 则 start；已 start 返回 null */
  ensureMessageStarted(id: string): AIStreamEvent | null;
  deltaMessage(id: string, block: ContentBlock): AIStreamEvent;
  completeMessage(id: string, options?: { citations?: Citation[] }): AIStreamEvent;

  startReasoning(id: string, visibility: ReasoningItem["visibility"]): AIStreamEvent;
  ensureReasoningStarted(id: string, visibility: ReasoningItem["visibility"]): AIStreamEvent | null;
  deltaReasoning(id: string, block: ContentBlock): AIStreamEvent;
  completeReasoning(id: string): AIStreamEvent;

  startToolCall(id: string, name: string): AIStreamEvent;
  deltaToolCall(id: string, delta: { argumentsText?: string }): AIStreamEvent;
  completeToolCall(id: string): AIStreamEvent;

  startServerTool(
    id: string,
    tool: string,
    options?: { name?: string; serverLabel?: string },
  ): AIStreamEvent;
  deltaServerTool(id: string, delta: { argumentsText?: string }): AIStreamEvent;
  completeServerTool(
    id: string,
    options?: { status?: "completed" | "failed"; providerPayload?: unknown },
  ): AIStreamEvent;

  /** 原子完成项（无 started 生命周期） */
  completeServerToolResult(item: ServerToolResultItem): AIStreamEvent;
  completeServerToolDiscovery(item: ServerToolDiscoveryItem): AIStreamEvent;

  /** 与已完成事件同源的有序 OutputItem[]，供 replayFromOutput */
  completedItems(): readonly OutputItem[];
  hasActive(): boolean;
  isActive(id: string): boolean;
  activeIds(): readonly string[];
};

/**
 * 创建流式 item session。
 * factory 必须与 adapter 当前 stream 共用，以保持 sequence 单调。
 */
export function createStreamingItemSession(factory: EventFactory): StreamingItemSession {
  const active = new Map<string, ActiveItem>();
  const completed: OutputItem[] = [];
  const completedIds = new Set<string>();

  function assertNotCompleted(id: string): void {
    if (completedIds.has(id)) {
      throw protocolError(`Item ${id} is already completed`);
    }
  }

  function assertNotActive(id: string): void {
    if (active.has(id)) {
      throw protocolError(`Item ${id} is already active`);
    }
  }

  function getActive<T extends ActiveItem["type"]>(id: string, expected: T): Extract<ActiveItem, { type: T }> {
    const item = active.get(id);
    if (!item) {
      throw protocolError(`Received ${expected} delta/completed for unknown item: ${id}`);
    }
    if (item.type !== expected) {
      throw protocolError(`Item ${id} started as ${item.type} but received ${expected} event`);
    }
    return item as Extract<ActiveItem, { type: T }>;
  }

  return {
    startMessage(id) {
      assertNotCompleted(id);
      assertNotActive(id);
      active.set(id, { type: "message", id, content: [] });
      return factory.messageStarted(id);
    },

    ensureMessageStarted(id) {
      if (active.has(id) || completedIds.has(id)) return null;
      return this.startMessage(id);
    },

    deltaMessage(id, block) {
      const item = getActive(id, "message");
      item.content.push(block);
      return factory.messageDelta(id, block);
    },

    completeMessage(id, options) {
      const item = getActive(id, "message");
      if (options?.citations && options.citations.length > 0) {
        item.citations = options.citations;
      }
      active.delete(id);
      const outputItem = messageItem(coalesceContentBlocks(item.content), {
        id: item.id,
        ...(item.citations && item.citations.length > 0 ? { citations: item.citations } : {}),
      });
      completed.push(outputItem);
      completedIds.add(id);
      return factory.messageCompleted(id, options?.citations ? { citations: options.citations } : undefined);
    },

    startReasoning(id, visibility) {
      assertNotCompleted(id);
      assertNotActive(id);
      active.set(id, { type: "reasoning", id, visibility, content: [] });
      return factory.reasoningStarted(id, visibility);
    },

    ensureReasoningStarted(id, visibility) {
      if (active.has(id) || completedIds.has(id)) return null;
      return this.startReasoning(id, visibility);
    },

    deltaReasoning(id, block) {
      const item = getActive(id, "reasoning");
      item.content.push(block);
      return factory.reasoningDelta(id, block);
    },

    completeReasoning(id) {
      const item = getActive(id, "reasoning");
      active.delete(id);
      completed.push(reasoningItem(coalesceContentBlocks(item.content), item.visibility, item.id));
      completedIds.add(id);
      return factory.reasoningCompleted(id);
    },

    startToolCall(id, name) {
      assertNotCompleted(id);
      assertNotActive(id);
      active.set(id, { type: "tool_call", id, name, argumentChunks: [] });
      return factory.toolCallStarted(id, name);
    },

    deltaToolCall(id, delta) {
      const item = getActive(id, "tool_call");
      if (delta.argumentsText) {
        item.argumentChunks.push(delta.argumentsText);
      }
      return factory.toolCallDelta(id, delta);
    },

    completeToolCall(id) {
      const item = getActive(id, "tool_call");
      active.delete(id);
      completed.push(toolCallItem(item.id, item.name, item.argumentChunks.join("")));
      completedIds.add(id);
      return factory.toolCallCompleted(id);
    },

    startServerTool(id, tool, options) {
      assertNotCompleted(id);
      assertNotActive(id);
      active.set(id, {
        type: "server_tool_call",
        id,
        tool,
        name: options?.name,
        argumentChunks: [],
        serverLabel: options?.serverLabel,
        status: "in_progress",
      });
      return factory.serverToolStarted(id, tool, options);
    },

    deltaServerTool(id, delta) {
      const item = getActive(id, "server_tool_call");
      if (delta.argumentsText) {
        item.argumentChunks.push(delta.argumentsText);
      }
      return factory.serverToolDelta(id, delta);
    },

    completeServerTool(id, options) {
      const item = getActive(id, "server_tool_call");
      item.status = options?.status ?? "completed";
      if (options?.providerPayload !== undefined) {
        item.providerPayload = options.providerPayload;
      }
      active.delete(id);
      const argumentsText = item.argumentChunks.join("");
      completed.push(
        serverToolCallItem(item.id, item.tool, {
          ...(item.name !== undefined ? { name: item.name } : {}),
          ...(argumentsText ? { argumentsText } : {}),
          ...(item.status ? { status: item.status } : {}),
          ...(item.serverLabel !== undefined ? { serverLabel: item.serverLabel } : {}),
          ...(item.providerPayload !== undefined ? { providerPayload: item.providerPayload } : {}),
        }),
      );
      completedIds.add(id);
      return factory.serverToolCompleted(id, options);
    },

    completeServerToolResult(item) {
      const orderId = item.id ?? `server_tool_result:${item.callId}:${completed.length}`;
      if (completedIds.has(orderId) || active.has(orderId)) {
        throw protocolError(`Item ${orderId} is already present`);
      }
      completed.push({ ...item } as OutputItem);
      completedIds.add(orderId);
      return factory.serverToolResultCompleted(item);
    },

    completeServerToolDiscovery(item) {
      if (completedIds.has(item.id) || active.has(item.id)) {
        throw protocolError(`Item ${item.id} is already present`);
      }
      completed.push({ ...item });
      completedIds.add(item.id);
      return factory.serverToolDiscoveryCompleted(item);
    },

    completedItems() {
      return completed;
    },

    hasActive() {
      return active.size > 0;
    },

    isActive(id) {
      return active.has(id);
    },

    activeIds() {
      return [...active.keys()];
    },
  };
}
