/**
 * 后端适配器
 *
 * 模块边界：各类 AI 后端 adapter 实现。
 * - responses
 * - messages
 * - chat.completions
 * - ollama
 * - mock
 *
 * 每个 adapter 实现 BackendAdapter 内部协议。
 */

export { ResponsesAdapter } from "./responses.js";
export type { ResponsesAdapterOptions } from "./responses.js";
export { MessagesAdapter } from "./messages.js";
export type { MessagesAdapterOptions } from "./messages.js";
export { ChatCompletionsAdapter } from "./chat-completions.js";
export type { ChatCompletionsAdapterOptions } from "./chat-completions.js";
export { OllamaAdapter } from "./ollama.js";
export type { OllamaAdapterOptions } from "./ollama.js";
export { MockAdapter } from "./mock.js";
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
  MockOutputStep,
  MockCompleteStep,
  MockErrorStep,
  MockInterruptStep,
  MockThrowStep,
  MockStep,
} from "./mock.js";
export { assertMockRequest, withMockStreaming } from "./mock.js";
