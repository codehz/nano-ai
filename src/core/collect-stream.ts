/**
 * collectStream — 流收集 helper
 *
 * 将 AsyncIterable<AIStreamEvent> 消费完毕并聚合力 AIResponse。
 * 适用于不需要逐事件处理的调用方。
 */

import type { AIStreamEvent, AIResponse } from "../types/index.js";
import { aggregateEvents } from "./aggregator.js";

export async function collectStream(
  stream: AsyncIterable<AIStreamEvent>,
): Promise<AIResponse> {
  const events: AIStreamEvent[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return aggregateEvents(events);
}
