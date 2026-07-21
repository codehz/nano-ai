/**
 * AIRequest — 统一请求模型
 *
 * 所有 adapter 都接受同一形状的 canonical request。
 */

import type { InstructionBlock } from "./content.js";
import type { InputItem } from "./items.js";

// ── 客户端工具定义 ────────────────────────────────────────────

export type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type ToolChoice = "auto" | "none" | { type: "tool"; name: string };

// ── 服务端工具定义 ────────────────────────────────────────────

export type WebSearchUserLocation = {
  type: "approximate";
  country?: string;
  city?: string;
  region?: string;
  timezone?: string;
};

export type WebSearchServerTool = {
  type: "web_search";
  allowedDomains?: string[];
  blockedDomains?: string[];
  userLocation?: WebSearchUserLocation;
  searchContextSize?: "low" | "medium" | "high";
};

export type CodeExecutionServerTool = {
  type: "code_execution";
  container?: {
    type: "auto";
    memoryLimit?: "1g" | "4g" | "16g" | "64g";
    fileIds?: string[];
  };
};

export type McpServerTool = {
  type: "mcp";
  serverLabel: string;
  serverUrl: string;
  serverDescription?: string;
  /** 每请求由调用方提供；不得写入日志或 opaque 回放。 */
  authorization?: string;
  allowedTools?: string[];
  /** 首版仅支持 never */
  requireApproval: "never";
};

/** Provider 托管执行的工具声明（不进客户端 tool loop） */
export type ServerToolDefinition = WebSearchServerTool | CodeExecutionServerTool | McpServerTool;

// ── include 控制 ──────────────────────────────────────────────

export type IncludeSettings = {
  usage?: "off" | "best_effort";
  billing?: "off" | "best_effort";
  providerMetadata?: "off" | "best_effort";
};

// ── reasoning level ───────────────────────────────────────────

/** Portable reasoning / thinking effort. Mapped per-adapter to provider wire fields. */
export type ReasoningLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** 可移植 reasoning level 枚举（单源；validation / provider 共用）。 */
export const REASONING_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ReasoningLevel[];

/** 用于校验任意字符串 membership；值域与 REASONING_LEVELS 一致。 */
export const REASONING_LEVEL_SET: ReadonlySet<string> = new Set(REASONING_LEVELS);

// ── 统一请求 ──────────────────────────────────────────────────

export type AIRequest = {
  instructions?: string | InstructionBlock[];
  input: InputItem[];
  tools?: ToolDefinition[];
  /** Provider 托管工具（web_search / code_execution / mcp 等）；与 tools 可共存 */
  serverTools?: ServerToolDefinition[];
  toolChoice?: ToolChoice;
  include?: IncludeSettings;
  metadata?: Record<string, string>;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Portable reasoning effort. Adapters map this to provider-native fields
   * (e.g. Responses `reasoning.effort`, Chat Completions `reasoning_effort`,
   * Messages `thinking`, Ollama `think`, Gemini `thinkingConfig`).
   * Unsupported levels throw.
   */
  reasoningLevel?: ReasoningLevel;
  /** AbortSignal 用于打断请求。abort 时 fetch 调用会被取消，流迭代器抛出 AbortError。 */
  signal?: AbortSignal;
};
