/**
 * OllamaAdapter wire / options 类型
 */

import type { HttpAdapterOptions } from "../../provider/http-adapter.js";

/** Ollama adapter 配置；apiKey 可选，默认连接本地服务。 */
export type OllamaAdapterOptions = HttpAdapterOptions;

// ── Ollama Chat API 类型 ──────────────────────────────────────

/** Ollama Chat API 的流式请求体。 */
export type OllamaChatRequest = {
  model: string;
  messages: OllamaMessage[];
  stream: true;
  keep_alive?: string | number;
  tools?: OllamaTool[];
  /** Portable reasoningLevel → think；minimal/xhigh/max 不支持 */
  think?: boolean | "low" | "medium" | "high";
  options?: {
    temperature?: number;
    num_predict?: number;
    [key: string]: unknown;
  };
};

/** Ollama 消息。 */
export type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
};

/** Ollama 工具调用。 */
export type OllamaToolCall = {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
};

/** Ollama 客户端工具。 */
export type OllamaTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};
