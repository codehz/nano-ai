/**
 * 运行时入口
 *
 * 模块边界：客户端、请求归一化、校验、错误模型。
 * 不依赖 stream / provider / adapters。
 */

export { createAIClient } from "./client.js";
export type { AIClient } from "./client.js";
export { normalizeRequest } from "./normalize.js";
export type { NormalizeOptions } from "./normalize.js";
export { validateRequest, assertValidRequest } from "./validation.js";
export type { ValidationIssue } from "./validation.js";
export { AIError, AIRequestError, AIProviderError, AIStreamError, AIMappingError, WarningCode } from "./errors.js";
