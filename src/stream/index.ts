/**
 * 流运行时
 *
 * 模块边界：事件工厂、流聚合、collectStream。
 * 不依赖 provider / adapters。
 */

export { createEventFactory } from "./event-factory.js";
export type { EventFactory, EventFactoryState, EventFactoryBackend } from "./event-factory.js";
export { aggregateEvents } from "./aggregator.js";
export { collectStream } from "./collect-stream.js";
export { mergeAuxiliary } from "./merge-auxiliary.js";
