import type { NormalizedRequest, PromptCacheMetadata, PromptCacheMode } from "../types/index.js";

export type PromptCacheAdapter = "responses" | "chat-completions" | "messages" | "gemini" | "ollama";

export type PromptCacheApplication = PromptCacheMetadata;

export function requestedPromptCacheMode(request: NormalizedRequest): PromptCacheMode {
  return request.cache?.mode ?? "auto";
}

export function promptCacheAdapterForKind(kind: string): PromptCacheAdapter | undefined {
  if (
    kind === "responses" ||
    kind === "chat-completions" ||
    kind === "messages" ||
    kind === "gemini" ||
    kind === "ollama"
  ) {
    return kind;
  }
  return undefined;
}

export function promptCacheMetadata(
  request: NormalizedRequest,
  adapter: PromptCacheAdapter,
  overrides: { keyApplied?: boolean; ttlApplied?: boolean; explicitApplied?: boolean } = {},
): PromptCacheApplication {
  const requestedMode = requestedPromptCacheMode(request);
  if (requestedMode === "off") {
    return { requestedMode, appliedMode: "off", keyApplied: false, ttlApplied: false };
  }

  const native = request.providerOptions?.cache;
  const portable = request.cache;
  let appliedMode: PromptCacheApplication["appliedMode"] = "implicit";
  let keyApplied = false;
  let ttlApplied = false;

  if (adapter === "responses") {
    const nativeOptions = native?.responses;
    const mode = nativeOptions?.promptCacheMode ?? (requestedMode === "explicit" ? "explicit" : undefined);
    keyApplied = mode !== "off" && Boolean(nativeOptions?.promptCacheKey ?? portable?.key);
    ttlApplied =
      mode !== "off" && Boolean(nativeOptions?.promptCacheRetention ?? mapPromptCacheRetention(portable?.ttl));
    appliedMode = mode === "off" ? "off" : mode === "explicit" ? "explicit" : "implicit";
  } else if (adapter === "chat-completions") {
    const options = native?.chatCompletions;
    keyApplied = Boolean(options?.promptCacheKey ?? portable?.key);
    ttlApplied = Boolean(options?.promptCacheRetention ?? mapPromptCacheRetention(portable?.ttl));
    appliedMode =
      requestedMode === "explicit" || Boolean(options?.promptCacheKey || options?.promptCacheRetention)
        ? "explicit"
        : "implicit";
  } else if (adapter === "messages") {
    const hasStablePrefix =
      Boolean(request.instructions) || request.input.length > 0 || (request.tools?.length ?? 0) > 0;
    const explicitRequested = requestedMode === "explicit" || native?.messages?.cacheTtl !== undefined;
    const explicit = explicitRequested && hasStablePrefix;
    appliedMode = explicit ? "explicit" : explicitRequested ? "unsupported" : "implicit";
    ttlApplied = explicit && Boolean(native?.messages?.cacheTtl ?? mapAnthropicCacheTtl(portable?.ttl));
  } else if (adapter === "gemini") {
    const cachedContent = native?.gemini?.cachedContent;
    if (cachedContent) {
      appliedMode = "explicit";
    } else {
      appliedMode = requestedMode === "explicit" ? "unsupported" : "implicit";
    }
  } else if (adapter === "ollama") {
    const keepAlive = native?.ollama?.keepAlive;
    appliedMode =
      requestedMode === "explicit" && keepAlive === undefined
        ? "unsupported"
        : requestedMode === "explicit"
          ? "explicit"
          : "implicit";
  }

  return {
    requestedMode,
    appliedMode: overrides.explicitApplied === true ? "explicit" : appliedMode,
    keyApplied: overrides.keyApplied ?? keyApplied,
    ttlApplied: overrides.ttlApplied ?? ttlApplied,
  };
}

export function applyPromptCacheFields(
  body: Record<string, unknown>,
  request: NormalizedRequest,
  adapter: PromptCacheAdapter,
): PromptCacheApplication {
  const portable = request.cache;
  const native = request.providerOptions?.cache;
  const metadata = promptCacheMetadata(request, adapter);
  if (portable?.mode === "off") return metadata;

  if (adapter === "responses") {
    const options = native?.responses;
    const key = options?.promptCacheKey ?? portable?.key;
    const mode = options?.promptCacheMode ?? (portable?.mode === "explicit" ? "explicit" : undefined);
    const retention = options?.promptCacheRetention ?? mapPromptCacheRetention(portable?.ttl);
    if (mode !== "off" && key) body.prompt_cache_key = key;
    if (mode || retention) {
      body.prompt_cache_options = {
        ...(mode ? { mode } : {}),
        ...(mode !== "off" && retention ? { retention } : {}),
      };
    }
    return metadata;
  }

  if (adapter === "chat-completions") {
    const options = native?.chatCompletions;
    const key = options?.promptCacheKey ?? portable?.key;
    const retention = options?.promptCacheRetention ?? mapPromptCacheRetention(portable?.ttl);
    if (key) body.prompt_cache_key = key;
    if (retention) body.prompt_cache_retention = retention;
    return metadata;
  }

  if (adapter === "gemini") {
    const cachedContent = native?.gemini?.cachedContent;
    if (cachedContent) body.cachedContent = cachedContent;
    return metadata;
  }

  if (adapter === "ollama") {
    const keepAlive = native?.ollama?.keepAlive;
    if (keepAlive !== undefined) body.keep_alive = keepAlive;
  }
  return metadata;
}

export function mapPromptCacheRetention(ttl: string | undefined): "in_memory" | "24h" | undefined {
  if (ttl === "short") return "in_memory";
  if (ttl === "long") return "24h";
  if (ttl === "in_memory" || ttl === "24h") return ttl;
  return undefined;
}

export function mapAnthropicCacheTtl(ttl: string | undefined): "5m" | "1h" | undefined {
  if (ttl === "short" || ttl === "5m") return "5m";
  if (ttl === "long" || ttl === "1h") return "1h";
  return undefined;
}
