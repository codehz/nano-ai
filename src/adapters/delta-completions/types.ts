/**
 * DeltaCompletionsAdapter wire / options 类型
 *
 * 面向残缺 OpenAI 兼容网关：SSE 可能只有
 * `data: {"choices":[{"delta":{"content":"..."}}]}`，
 * 无 id / index / finish_reason。
 */

import type { HttpAdapterOptions } from "../../provider/http-adapter.js";

/** 残缺 chat/completions 兼容适配器；必须显式 baseUrl，避免误打 OpenAI。 */
export type DeltaCompletionsAdapterOptions = HttpAdapterOptions & {
  baseUrl: string;
};

/** 出站请求：仅文本 messages + stream。不发送 n / tools / reasoning。 */
export type DeltaChatRequest = {
  model: string;
  messages: DeltaChatMessage[];
  stream: true;
  temperature?: number;
  max_tokens?: number;
};

/** 仅文本 chat 消息。 */
export type DeltaChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
