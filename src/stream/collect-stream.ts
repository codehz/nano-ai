/**
 * collectStream — 流收集 helper
 *
 * 将 AsyncIterable<AIStreamEvent> 消费完毕并聚合力 AIResponse。
 * 适用于不需要逐事件处理的调用方。
 */

import type { AIStreamEvent, AIResponse } from "../types/index.js";
import { aggregateEvent, createAggregatorState, finalizeAggregation } from "./aggregator.js";

/** 消费完整个事件流并聚合为 AIResponse；适用于不需要逐事件处理的调用方。 */
export async function collectStream(stream: AsyncIterable<AIStreamEvent>): Promise<AIResponse> {
  const state = createAggregatorState();

  for await (const event of stream) {
    aggregateEvent(state, event);
  }

  return finalizeAggregation(state);
}
