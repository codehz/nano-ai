/**
 * AI 客户端入口
 *
 * 打通 createAIClient() 到 adapter 调用之间的公共入口。
 */

import type { AIRequest, AIStreamEvent, AIClient, CreateAIClientOptions } from "../types/index.js";
import { normalizeRequest } from "./normalize.js";

export function createAIClient(options: CreateAIClientOptions): AIClient {
  const { adapter, model, defaults } = options;

  const client: AIClient = {
    stream(request: AIRequest): AsyncIterable<AIStreamEvent> {
      const normalized = normalizeRequest(request, { model, defaults });
      return adapter.stream(normalized);
    },
  };

  return client;
}

export type { AIClient, CreateAIClientOptions } from "../types/index.js";
