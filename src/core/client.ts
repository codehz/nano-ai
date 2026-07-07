/**
 * AI 客户端入口（桩）
 *
 * 当前 Phase 0：仅提供骨架类型和空实现。
 * Phase 2 将实现完整的 createAIClient 和 client.stream()。
 */

export interface AIClient {
  stream(request: unknown): AsyncIterable<unknown>;
}

export function createAIClient(_options: unknown): AIClient {
  throw new Error("not implemented: Phase 2");
}
