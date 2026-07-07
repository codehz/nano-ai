/**
 * 后端适配器
 *
 * 模块边界：各类 AI 后端 adapter 实现。
 * - responses
 * - messages
 * - chat.completions
 *
 * 每个 adapter 实现 BackendAdapter 内部协议。
 */

export { ResponsesAdapter } from "./responses.js";
export type { ResponsesAdapterOptions } from "./responses.js";
export { MessagesAdapter } from "./messages.js";
export type { MessagesAdapterOptions } from "./messages.js";
export { ChatCompletionsAdapter } from "./chat-completions.js";
export type { ChatCompletionsAdapterOptions } from "./chat-completions.js";
