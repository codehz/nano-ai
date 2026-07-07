/**
 * 核心运行时
 *
 * 模块边界：客户端入口、请求归一化、事件工厂、流聚合器。
 * 不依赖具体 adapter 实现。
 */

export { createAIClient } from "./client.js";
export type { AIClient } from "./client.js";
export { normalizeRequest } from "./normalize.js";
export type { NormalizeOptions } from "./normalize.js";
export { validateRequest, assertValidRequest } from "./validation.js";
export type { ValidationIssue } from "./validation.js";
export { AIError, AIRequestError, AIProviderError, AIStreamError, AIMappingError, WarningCode } from "./errors.js";
export { createEventFactory } from "./event-factory.js";
export type { EventFactory, EventFactoryState, EventFactoryBackend } from "./event-factory.js";
export { aggregateEvents } from "./aggregator.js";
export { collectStream } from "./collect-stream.js";
