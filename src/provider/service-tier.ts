/**
 * Portable serviceTier → provider wire `service_tier` 映射
 *
 * 未设置时不写相关字段。无法映射的 adapter / 值抛 AIRequestError(UNSUPPORTED_SERVICE_TIER)。
 */

import { AIRequestError } from "../runtime/errors.js";
import type { ServiceTier } from "../types/request.js";
export { SERVICE_TIERS, SERVICE_TIER_SET } from "../types/request.js";

export type OpenAIServiceTier = ServiceTier;

export type MessagesServiceTier = "auto" | "standard_only";

const MESSAGES_SERVICE_TIER: Record<Exclude<ServiceTier, "flex">, MessagesServiceTier> = {
  auto: "auto",
  default: "standard_only",
  fast: "auto",
  priority: "auto",
};

/** 若该 adapter 完全不支持 serviceTier 则抛 AIRequestError。 */
export function assertUnsupportedServiceTier(tier: ServiceTier | undefined, adapterKind: string): void {
  if (tier === undefined) return;
  throw new AIRequestError(`serviceTier is not supported by the ${adapterKind} adapter`, "UNSUPPORTED_SERVICE_TIER");
}

/** Responses / Chat Completions：顶层 `service_tier` 原样透传。 */
export function mapOpenAiServiceTier(tier: ServiceTier): OpenAIServiceTier {
  return tier;
}

/**
 * Messages：`auto` / `fast` / `priority` → `auto`（有 Priority 容量时使用）；
 * `default` → `standard_only`；`flex` 不支持。
 */
export function mapMessagesServiceTier(tier: ServiceTier): MessagesServiceTier {
  if (tier === "flex") {
    throw new AIRequestError(
      `serviceTier "${tier}" is not supported by the messages adapter`,
      "UNSUPPORTED_SERVICE_TIER",
    );
  }
  return MESSAGES_SERVICE_TIER[tier];
}

/** 从 provider 响应提取 applied service_tier，供 providerMetadata 使用。 */
export function serviceTierMetadata(value: unknown): { serviceTier: string } | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return undefined;
  return { serviceTier: value };
}
