/**
 * Opaque replay source 常量，避免 adapter 内 magic string 漂移。
 * 须与 acceptOpaqueReplay / opaqueItem 入站过滤一致。
 */

export const OPAQUE_SOURCE = {
  CHAT_COMPLETIONS: "chat.completions",
  MESSAGES: "messages",
  OLLAMA: "ollama",
  GEMINI: "gemini",
  RESPONSES: "responses",
} as const;

export type OpaqueSourceId = (typeof OPAQUE_SOURCE)[keyof typeof OPAQUE_SOURCE];
