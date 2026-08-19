/** Request-level portable prompt cache controls and provider extensions. */

export type PromptCacheMode = "off" | "auto" | "explicit";

export type PromptCacheSettings = {
  /** Cache strategy; when omitted, the adapter/provider decides. */
  mode?: PromptCacheMode;
  /** Session or tenant routing hint; providers may ignore it. */
  key?: string;
  /** Provider-specific retention hint. */
  ttl?: "short" | "long" | string;
};

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

export type PromptCacheMetadata = {
  requestedMode: PromptCacheMode;
  appliedMode: "off" | "implicit" | "explicit" | "unsupported";
  keyApplied: boolean;
  ttlApplied: boolean;
};
