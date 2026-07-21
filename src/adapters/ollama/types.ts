/**
 * OllamaAdapter wire / options 类型
 */

import type { FetchFn } from "../../types/index.js";

export type OllamaAdapterOptions = {
  /** Ollama 服务地址，默认 http://localhost:11434 */
  baseUrl?: string;
  /** 可选 API key（用于需要认证的代理场景） */
  apiKey?: string;
  /** 可注入自定义 fetch 实现 */
  fetch?: FetchFn;
  /** 额外请求头；后写覆盖内置 Content-Type / Authorization */
  headers?: Record<string, string>;
  /** 额外 body 顶层字段；浅层合并，同名键可覆盖 */
  extraBody?: Record<string, unknown>;
};

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
