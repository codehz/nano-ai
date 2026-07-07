/**
 * AI 客户端入口（桩）
 *
 * 当前 Phase 1：类型已就绪，实现仍为桩。
 * Phase 2 将实现完整的 createAIClient 和 client.stream()。
 */

import type { AIRequest, AIStreamEvent, AIClient, CreateAIClientOptions } from "../types/index.js";

export function createAIClient(_options: CreateAIClientOptions): AIClient {
  throw new Error("not implemented: Phase 2");
}

export type { AIClient, CreateAIClientOptions } from "../types/index.js";
