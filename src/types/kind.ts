/**
 * Adapter kind 标识
 *
 * KnownAdapterKind 覆盖内置 adapter；
 * AdapterKind 额外接受任意 string，便于自定义 backend 扩展（无需改库联合类型）。
 */

export const KNOWN_ADAPTER_KINDS = ["chat-completions", "messages", "responses", "ollama", "gemini", "mock"] as const;

export type KnownAdapterKind = (typeof KNOWN_ADAPTER_KINDS)[number];

/** 内置 kind 自动补全 + 自定义 string 扩展 */
export type AdapterKind = KnownAdapterKind | (string & {});
