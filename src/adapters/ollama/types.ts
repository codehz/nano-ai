/**
 * OllamaAdapter wire / options 类型
 */

import type { HttpAdapterOptions } from "../../provider/http-adapter.js";

/**
 * apiKey 可选（代理鉴权）；默认 baseUrl http://localhost:11434
 */
export type OllamaAdapterOptions = HttpAdapterOptions;

// ── Ollama Chat API 类型 ──────────────────────────────────────

export type OllamaChatRequest = {
  model: string;
  messages: OllamaMessage[];
  stream: true;
  tools?: OllamaTool[];
  /** Portable reasoningLevel → think；minimal/xhigh/max 不支持 */
  think?: boolean | "low" | "medium" | "high";
  options?: {
    temperature?: number;
    num_predict?: number;
    [key: string]: unknown;
  };
};

export type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
};

export type OllamaToolCall = {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
};

export type OllamaTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};
