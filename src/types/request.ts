/**
 * AIRequest — 统一请求模型
 *
 * 所有 adapter 都接受同一形状的 canonical request。
 */

import type { InstructionBlock } from "./content.js";
import type { InputItem } from "./items.js";

// ── 工具定义 ──────────────────────────────────────────────────

export type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type ToolChoice = "auto" | "none" | { type: "tool"; name: string };

// ── include 控制 ──────────────────────────────────────────────

export type IncludeSettings = {
  usage?: "off" | "best_effort";
  billing?: "off" | "best_effort";
  providerMetadata?: "off" | "best_effort";
};

// ── reasoning level ───────────────────────────────────────────

/** Portable reasoning / thinking effort. Mapped per-adapter to provider wire fields. */
export type ReasoningLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// ── 统一请求 ──────────────────────────────────────────────────

export type AIRequest = {
  instructions?: string | InstructionBlock[];
  input: InputItem[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  include?: IncludeSettings;
  metadata?: Record<string, string>;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Portable reasoning effort. Adapters map this to provider-native fields
   * (e.g. Responses `reasoning.effort`, Chat Completions `reasoning_effort`,
   * Messages `thinking`, Ollama `think`). Unsupported levels throw.
   */
  reasoningLevel?: ReasoningLevel;
  /** AbortSignal 用于打断请求。abort 时 fetch 调用会被取消，流迭代器抛出 AbortError。 */
  signal?: AbortSignal;
};
