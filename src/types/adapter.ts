/**
 * BackendAdapter — adapter 内部协议和 client 公开类型
 *
 * adapter 对前台只暴露一个统一适配点。
 * 能力矩阵在此落成代码而非仅存在于文档。
 */

import type { AIRequest } from "./request.js";
import type { AIStreamEvent } from "./events.js";

// ── 公共工具类型 ──────────────────────────────────────────────

/** HTTP fetch 函数签名，用于注入自定义请求实现（测试／代理） */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

// ── 归一化请求 ────────────────────────────────────────────────

export type NormalizedRequest = AIRequest & {
  model: string;
  requestId: string;
};

// ── 能力矩阵 ──────────────────────────────────────────────────

export type AdapterCapabilities = {
  nativeStreaming: boolean;
  messageStreaming: boolean;
  reasoningStreaming: boolean;
  toolCallStreaming: boolean;
  hiddenReasoningReplay: "full" | "partial" | "none";
  replayFidelity: "high" | "medium" | "low";
  tools: boolean;
  usage: "full" | "partial" | "none";
  billing: "direct" | "lookup" | "derived" | "none";
  providerMetadata: boolean;
};

// ── 能力矩阵常量（文档中的能力表在此落代码） ────────────────

export const CAPABILITY_MATRIX = {
  responses: {
    nativeStreaming: true,
    messageStreaming: true,
    reasoningStreaming: true,
    toolCallStreaming: true,
    hiddenReasoningReplay: "full" as const,
    replayFidelity: "high" as const,
    tools: true,
    usage: "full" as const,
    billing: "lookup" as const,
    providerMetadata: true,
  },
  messages: {
    nativeStreaming: true,
    messageStreaming: true,
    reasoningStreaming: false, // 条件支持，默认 false
    toolCallStreaming: true,
    hiddenReasoningReplay: "partial" as const,
    replayFidelity: "medium" as const,
    tools: true,
    usage: "full" as const,
    billing: "lookup" as const,
    providerMetadata: true,
  },
  "chat.completions": {
    nativeStreaming: true,
    messageStreaming: true,
    reasoningStreaming: false,
    toolCallStreaming: false, // 中，默认 false
    hiddenReasoningReplay: "none" as const,
    replayFidelity: "low" as const,
    tools: true,
    usage: "full" as const,
    billing: "derived" as const,
    providerMetadata: false,
  },
  ollama: {
    nativeStreaming: true,
    messageStreaming: true,
    reasoningStreaming: false,
    toolCallStreaming: false,
    hiddenReasoningReplay: "none" as const,
    replayFidelity: "low" as const,
    tools: true,
    usage: "partial" as const,
    billing: "none" as const,
    providerMetadata: false,
  },
  mock: {
    nativeStreaming: false,
    messageStreaming: true,
    reasoningStreaming: false,
    toolCallStreaming: true,
    hiddenReasoningReplay: "none" as const,
    replayFidelity: "high" as const,
    tools: true,
    usage: "none" as const,
    billing: "none" as const,
    providerMetadata: true,
  },
} as const satisfies Record<string, AdapterCapabilities>;

// ── Adapter 接口 ──────────────────────────────────────────────

export interface BackendAdapter {
  readonly kind: "chat-completions" | "messages" | "responses" | "ollama" | "mock";
  readonly capabilities: AdapterCapabilities;
  stream(request: NormalizedRequest): AsyncIterable<AIStreamEvent>;
}

// ── Client 公开类型 ───────────────────────────────────────────

export type CreateAIClientOptions = {
  adapter: BackendAdapter;
  model: string;
  defaults?: Partial<AIRequest>;
};

export interface AIClient {
  stream(request: AIRequest): AsyncIterable<AIStreamEvent>;
}
