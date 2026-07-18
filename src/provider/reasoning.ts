/**
 * Portable reasoningLevel → provider wire 字段映射
 *
 * 第一版只处理 level 枚举；budget/summary 等特化字段不在此层。
 * 无法映射的 level 抛 AIRequestError(UNSUPPORTED_REASONING_LEVEL)。
 */

import { AIRequestError } from "../runtime/errors.js";
import type { ReasoningLevel } from "../types/request.js";

export const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ReasoningLevel[];

export const REASONING_LEVEL_SET: ReadonlySet<string> = new Set(REASONING_LEVELS);

const MESSAGES_BUDGET_RATIOS: Record<Exclude<ReasoningLevel, "none">, number> = {
  minimal: 0.02,
  low: 0.1,
  medium: 0.3,
  high: 0.6,
  xhigh: 0.9,
  max: 0.95,
};

const OLLAMA_SUPPORTED = new Set<ReasoningLevel>(["none", "low", "medium", "high"]);
const GEMINI_SUPPORTED = new Set<ReasoningLevel>(["none", "minimal", "low", "medium", "high"]);

export type OpenAIReasoningEffort = ReasoningLevel;

export type MessagesThinkingConfig =
  | { type: "disabled" }
  | { type: "enabled"; budget_tokens: number };

export type OllamaThinkValue = false | "low" | "medium" | "high";

export type GeminiThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export type GeminiThinkingConfig =
  | { includeThoughts: false }
  | { includeThoughts: true; thinkingLevel: GeminiThinkingLevel };

/** 若 level 不在 supported 集合内则抛 AIRequestError。 */
export function assertSupportedReasoningLevel(
  level: ReasoningLevel,
  supported: ReadonlySet<ReasoningLevel>,
  adapterKind: string,
): void {
  if (supported.has(level)) return;
  throw new AIRequestError(
    `reasoningLevel "${level}" is not supported by the ${adapterKind} adapter`,
    "UNSUPPORTED_REASONING_LEVEL",
  );
}

/** Responses API：`reasoning: { effort }` */
export function mapResponsesReasoning(level: ReasoningLevel): { effort: OpenAIReasoningEffort } {
  return { effort: level };
}

/** Chat Completions：顶层 `reasoning_effort` */
export function mapChatCompletionsReasoningEffort(level: ReasoningLevel): OpenAIReasoningEffort {
  return level;
}

/**
 * Messages thinking budget。
 * 基于 maxTokens 按比例推导，clamp 到 [1024, max(1024, maxTokens - 1)]，
 * 满足 Anthropic budget_tokens < max_tokens。
 */
export function mapMessagesThinkingBudget(level: Exclude<ReasoningLevel, "none">, maxTokens: number): number {
  const ratio = MESSAGES_BUDGET_RATIOS[level];
  const raw = Math.round(maxTokens * ratio);
  const upper = Math.max(1024, maxTokens - 1);
  return Math.min(Math.max(raw, 1024), upper);
}

/** Messages API：`thinking` 字段 */
export function mapMessagesThinking(level: ReasoningLevel, maxTokens: number): MessagesThinkingConfig {
  if (level === "none") {
    return { type: "disabled" };
  }
  return {
    type: "enabled",
    budget_tokens: mapMessagesThinkingBudget(level, maxTokens),
  };
}

/** Ollama：`think` 字段；minimal/xhigh/max 不支持 */
export function mapOllamaThink(level: ReasoningLevel): OllamaThinkValue {
  assertSupportedReasoningLevel(level, OLLAMA_SUPPORTED, "ollama");
  if (level === "none") return false;
  // narrow after assert: only low|medium|high remain
  return level as Exclude<OllamaThinkValue, false>;
}

/** Gemini：`generationConfig.thinkingConfig`；xhigh/max 不支持 */
export function mapGeminiThinking(level: ReasoningLevel): GeminiThinkingConfig {
  assertSupportedReasoningLevel(level, GEMINI_SUPPORTED, "gemini");
  if (level === "none") {
    return { includeThoughts: false };
  }

  const thinkingLevel = level.toUpperCase() as GeminiThinkingLevel;
  return {
    includeThoughts: true,
    thinkingLevel,
  };
}
