/**
 * GeminiAdapter wire / options 类型
 */

import type { HttpAdapterOptions } from "../../provider/http-adapter.js";

/** Gemini adapter 配置；apiKey 必填。 */
export type GeminiAdapterOptions = HttpAdapterOptions & {
  apiKey: string;
};

// ── Gemini wire 类型 ──────────────────────────────────────────

/** Gemini 内容 part。 */
export type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  functionCall?: {
    name: string;
    args?: Record<string, unknown>;
    id?: string;
  };
  functionResponse?: {
    name: string;
    response?: Record<string, unknown>;
    id?: string;
  };
  [key: string]: unknown;
};

/** Gemini 对话内容。 */
export type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

/** Gemini function declaration。 */
export type GeminiFunctionDeclaration = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

/** Gemini 工具容器。 */
export type GeminiTool = {
  functionDeclarations: GeminiFunctionDeclaration[];
};

/** Gemini function calling 配置。 */
export type GeminiFunctionCallingConfig = {
  mode: "AUTO" | "ANY" | "NONE";
  allowedFunctionNames?: string[];
};

/** Gemini generateContent 请求体。 */
export type GeminiGenerateContentRequest = {
  contents: GeminiContent[];
  cachedContent?: string;
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: GeminiTool[];
  toolConfig?: { functionCallingConfig: GeminiFunctionCallingConfig };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    thinkingConfig?:
      | { includeThoughts: false }
      | { includeThoughts: true; thinkingLevel: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" };
  };
};

/** Gemini token 使用量元数据。 */
export type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
};

/** Gemini 流式响应 chunk。 */
export type GeminiStreamChunk = {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
    index?: number;
    safetyRatings?: unknown[];
  }>;
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: unknown[];
  };
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  responseId?: string;
};
