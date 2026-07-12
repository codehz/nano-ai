/**
 * AI 客户端入口
 *
 * 打通 createAIClient() 到 adapter 调用之间的公共入口。
 */

import type { AIRequest, AIStreamEvent, AIClient, CreateAIClientOptions } from "../types/index.js";
import { normalizeRequest } from "./normalize.js";

export function createAIClient(options: CreateAIClientOptions): AIClient {
  const { adapter, model, defaults, signal: defaultSignal } = options;

  const client: AIClient = {
    stream(request: AIRequest): AsyncIterable<AIStreamEvent> {
      // 合并 client 级别的默认 signal 和请求级别的 signal
      const signal = mergeAbortSignals(defaultSignal, request.signal);
      const normalized = normalizeRequest({ ...request, signal }, { model, defaults });
      return adapter.stream(normalized);
    },
  };

  return client;
}

/**
 * 合并多个 AbortSignal：任一 signal abort 即触发。
 * 如果没有 signal 需要合并则返回 undefined。
 */
function mergeAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const valid = signals.filter((s): s is AbortSignal => s != null);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];
  return AbortSignal.any(valid);
}

export type { AIClient, CreateAIClientOptions } from "../types/index.js";
