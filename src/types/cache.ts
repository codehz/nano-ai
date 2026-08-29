/** Request-level portable prompt cache controls and provider extensions. */

/** Prompt cache 的跨 provider 策略。 */
export type PromptCacheMode = "off" | "auto" | "explicit";

/** 请求级 prompt cache 控制和路由提示。 */
export type PromptCacheSettings = {
  /** Cache strategy; when omitted, the adapter/provider decides. */
  mode?: PromptCacheMode;
  /** Session or tenant routing hint; providers may ignore it. */
  key?: string;
  /** Provider-specific retention hint. */
  ttl?: "short" | "long" | string;
};

/** Provider-specific prompt cache extensions. */
export type ProviderCacheOptions = {
  responses?: {
    promptCacheKey?: string;
    promptCacheRetention?: "in_memory" | "24h";
    promptCacheMode?: "implicit" | "explicit" | "off";
  };
  chatCompletions?: {
    promptCacheKey?: string;
    promptCacheRetention?: "in_memory" | "24h";
  };
  messages?: {
    cacheTtl?: "5m" | "1h";
    betaHeader?: string;
  };
  gemini?: {
    cachedContent?: string;
  };
  ollama?: {
    keepAlive?: string | number;
  };
};

/** Response metadata describing the effective cache behavior. */
export type PromptCacheMetadata = {
  requestedMode: PromptCacheMode;
  appliedMode: "off" | "implicit" | "explicit" | "unsupported";
  keyApplied: boolean;
  ttlApplied: boolean;
};
