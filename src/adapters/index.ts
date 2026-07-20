/**
 * 后端适配器
 *
 * 模块边界：各类 AI 后端 adapter 实现。
 * - responses
 * - messages
 * - chat.completions
 * - ollama
 * - gemini
 * - mock
 *
 * 每个 adapter 实现 BackendAdapter 内部协议。
 */

export { ResponsesAdapter } from "./responses/index.js";
export type { ResponsesAdapterOptions } from "./responses/index.js";
export { MessagesAdapter } from "./messages/index.js";
export type { MessagesAdapterOptions } from "./messages/index.js";
export { ChatCompletionsAdapter } from "./chat-completions/index.js";
export type { ChatCompletionsAdapterOptions } from "./chat-completions/index.js";
export { OllamaAdapter } from "./ollama/index.js";
export type { OllamaAdapterOptions } from "./ollama/index.js";
export { GeminiAdapter } from "./gemini/index.js";
export type { GeminiAdapterOptions } from "./gemini/index.js";
export { MockAdapter } from "./mock/index.js";
export type {
  MockAdapterOptions,
  MockHistoryRecord,
  MockTextStreamOptions,
  MockInputExpectation,
  MockRequestExpectation,
  MockHandlerContext,
  MockHandler,
  MockStaticHandler,
  MockWarningStep,
  MockAuxiliaryStep,
  MockMessageStep,
  MockReasoningStep,
  MockToolCallStep,
  MockServerToolCallStep,
  MockServerToolResultStep,
  MockServerToolDiscoveryStep,
  MockOutputStep,
  MockCompleteStep,
  MockErrorStep,
  MockInterruptStep,
  MockThrowStep,
  MockStep,
} from "./mock/index.js";
export { assertMockRequest, withMockStreaming } from "./mock/index.js";
