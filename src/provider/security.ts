/**
 * Adapter 边界安全辅助
 *
 * - opaque replay envelope（大小 / 深度；emit 与 accept 共用）
 * - provider HTTP 错误 body 出站脱敏
 */

import { AIProviderError, AIRequestError } from "../runtime/errors.js";

/** 默认单条 opaque payload 上限（JSON.stringify 的 UTF-16 码元长度）。 */
export const DEFAULT_MAX_OPAQUE_PAYLOAD_BYTES = 1 * 1024 * 1024;
/** 硬顶：配置不可超过；挡住离谱 blob / DoS。 */
export const HARD_MAX_OPAQUE_PAYLOAD_BYTES = 8 * 1024 * 1024;
/**
 * 默认 opaque 体积上限（与 DEFAULT_MAX_OPAQUE_PAYLOAD_BYTES 同值）。
 * 历史导出名；新代码优先用 DEFAULT_ / HARD_ 常量。
 */
export const MAX_OPAQUE_PAYLOAD_BYTES = DEFAULT_MAX_OPAQUE_PAYLOAD_BYTES;
export const MAX_OPAQUE_JSON_DEPTH = 8;
export const PROVIDER_ERROR_MESSAGE_MAX_LEN = 500;
export const PROVIDER_ERROR_RAW_BODY_THRESHOLD = 200;

export type OpaqueEnvelopeResult = { ok: true } | { ok: false; reason: string };

/** envelope 校验选项：体积上限经 clamp 后生效。 */
export type OpaqueEnvelopeOptions = {
  /** JSON.stringify 长度上限；省略则用默认 1 MiB；夹到 [1, HARD]。 */
  maxBytes?: number;
};

/**
 * 将调用方配置的 opaque 上限夹到合法区间。
 * 非有限 / <1 → 默认；> HARD → HARD。
 */
export function clampOpaquePayloadLimit(maxBytes?: number): number {
  if (maxBytes === undefined || !Number.isFinite(maxBytes)) {
    return DEFAULT_MAX_OPAQUE_PAYLOAD_BYTES;
  }
  const n = Math.floor(maxBytes);
  if (n < 1) {
    return DEFAULT_MAX_OPAQUE_PAYLOAD_BYTES;
  }
  return Math.min(n, HARD_MAX_OPAQUE_PAYLOAD_BYTES);
}

/** 测量 JSON 值嵌套深度（对象/数组）；循环引用按已访问节点深度计。 */
export function measureJsonDepth(value: unknown, seen = new WeakSet<object>()): number {
  if (value === null || typeof value !== "object") {
    return 0;
  }

  if (seen.has(value)) {
    return 0;
  }
  seen.add(value);

  let maxChild = 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      maxChild = Math.max(maxChild, measureJsonDepth(item, seen));
    }
  } else {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      maxChild = Math.max(maxChild, measureJsonDepth((value as Record<string, unknown>)[key], seen));
    }
  }

  return 1 + maxChild;
}

/**
 * Opaque replay 通用 envelope：必须是 object、体积 ≤ limit、深度 ≤ 8。
 * 不校验 adapter 专用字段形状。emit / accept 共用。
 */
export function validateOpaqueReplayEnvelope(
  payload: unknown,
  options?: OpaqueEnvelopeOptions,
): OpaqueEnvelopeResult {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "payload must be an object" };
  }

  let raw: string;
  try {
    raw = JSON.stringify(payload);
  } catch {
    return { ok: false, reason: "payload is not JSON-serializable" };
  }

  if (raw === undefined) {
    return { ok: false, reason: "payload is not JSON-serializable" };
  }

  const maxBytes = clampOpaquePayloadLimit(options?.maxBytes);
  if (raw.length > maxBytes) {
    return {
      ok: false,
      reason: `opaque payload exceeds max size (${raw.length} > ${maxBytes})`,
    };
  }

  const depth = measureJsonDepth(payload);
  if (depth > MAX_OPAQUE_JSON_DEPTH) {
    return {
      ok: false,
      reason: `opaque payload nesting depth (${depth}) exceeds max (${MAX_OPAQUE_JSON_DEPTH})`,
    };
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
