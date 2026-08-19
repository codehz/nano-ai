/**
 * Adapter 边界安全辅助
 *
 * Opaque replay 只保留 provider wire envelope 的基本可序列化检查；
 * 客户端库不对 payload 施加大小或嵌套深度上限。
 */

import { AIProviderError, AIRequestError } from "../runtime/errors.js";

/** Legacy compatibility constants; opaque replay is no longer size/depth limited. */
export const DEFAULT_MAX_OPAQUE_PAYLOAD_BYTES = Number.POSITIVE_INFINITY;
export const HARD_MAX_OPAQUE_PAYLOAD_BYTES = Number.POSITIVE_INFINITY;
export const MAX_OPAQUE_PAYLOAD_BYTES = Number.POSITIVE_INFINITY;
export const MAX_OPAQUE_JSON_DEPTH = Number.POSITIVE_INFINITY;
export const PROVIDER_ERROR_MESSAGE_MAX_LEN = 500;
export const PROVIDER_ERROR_RAW_BODY_THRESHOLD = 200;

export type OpaqueEnvelopeResult = { ok: true } | { ok: false; reason: string };

/** 保留旧参数类型以避免内部 adapter 扩展点被无意义地破坏；maxBytes 不再生效。 */
export type OpaqueEnvelopeOptions = {
  /** Deprecated and ignored. Kept for source compatibility. */
  maxBytes?: number;
};

/** Deprecated compatibility helper; limits are intentionally no longer applied. */
export function clampOpaquePayloadLimit(maxBytes?: number): number {
  return Number.isFinite(maxBytes) && maxBytes !== undefined ? maxBytes : Number.POSITIVE_INFINITY;
}

/** Deprecated compatibility helper; retained for callers that used the old diagnostic. */
export function measureJsonDepth(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(measureJsonDepth));
  return 1 + Math.max(0, ...Object.values(value as Record<string, unknown>).map(measureJsonDepth));
}
/** Opaque payload 必须是 object 且可被 JSON 序列化；不限制大小或深度。 */
export function validateOpaqueReplayEnvelope(payload: unknown, _options?: OpaqueEnvelopeOptions): OpaqueEnvelopeResult {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "payload must be an object" };
  }

  try {
    if (JSON.stringify(payload) === undefined) {
      return { ok: false, reason: "payload is not JSON-serializable" };
    }
  } catch {
    return { ok: false, reason: "payload is not JSON-serializable" };
  }

  return { ok: true };
}

/** envelope 失败时抛 AIRequestError（入站 accept 路径）。 */
export function assertOpaqueReplayEnvelope(payload: unknown, options?: OpaqueEnvelopeOptions): void {
  const result = validateOpaqueReplayEnvelope(payload, options);
  if (!result.ok) {
    throw new AIRequestError(`Invalid opaque replay payload: ${result.reason}`, "INVALID_OPAQUE_REPLAY");
  }
}

/**
 * 从 provider HTTP 错误 body 提取可对外暴露的短消息，避免泄漏 HTML / 内部路径等。
 */
export function extractProviderErrorMessage(body: string, status: number): string {
  if (!body) return `HTTP ${status}`;

  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const errorField = record.error;
      let msg: unknown;
      if (errorField && typeof errorField === "object" && errorField !== null) {
        msg = (errorField as Record<string, unknown>).message;
      }
      if (typeof msg !== "string") {
        msg = typeof errorField === "string" ? errorField : record.message;
      }
      if (typeof msg === "string" && msg.length > 0) {
        return msg.slice(0, PROVIDER_ERROR_MESSAGE_MAX_LEN);
      }
    }
  } catch {
    // not JSON
  }

  const trimmed = body.trimStart();
  if (trimmed.startsWith("<!") || trimmed.startsWith("<html") || body.length > PROVIDER_ERROR_RAW_BODY_THRESHOLD) {
    return `HTTP ${status}. Body omitted (${body.length} bytes)`;
  }

  return body.slice(0, PROVIDER_ERROR_MESSAGE_MAX_LEN);
}

/** 统一构造脱敏后的 AIProviderError。 */
export function providerHttpError(status: number, body: string): AIProviderError {
  const safe = extractProviderErrorMessage(body, status);
  return new AIProviderError(`Provider returned ${status}: ${safe}`, "PROVIDER_ERROR", status, safe);
}
