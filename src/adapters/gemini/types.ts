/**
 * GeminiAdapter wire / options 类型
 */

import type { HttpAdapterOptions } from "../../provider/http-adapter.js";

/** apiKey 必填；默认 baseUrl https://generativelanguage.googleapis.com/v1beta */
export type GeminiAdapterOptions = HttpAdapterOptions & {
  apiKey: string;
};

// ── Gemini wire 类型 ──────────────────────────────────────────

export type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
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

export type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

export type GeminiFunctionDeclaration = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

export type GeminiTool = {
  functionDeclarations: GeminiFunctionDeclaration[];
};

export type GeminiFunctionCallingConfig = {
  mode: "AUTO" | "ANY" | "NONE";
  allowedFunctionNames?: string[];
};

export type GeminiGenerateContentRequest = {
  contents: GeminiContent[];
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

export type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
};

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
