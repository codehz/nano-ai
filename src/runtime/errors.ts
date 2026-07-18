/**
 * 公共错误模型
 *
 * 把失败、降级、断流三类情况明确区分：
 * - 致命错误 → 同步抛错或迭代器抛错
 * - 非致命差异 → warning 通道
 * - 流中断 → 不伪造 response.completed
 */

// ── 错误类型 ──────────────────────────────────────────────────

export type ErrorCode =
  | "INPUT_EMPTY"
  | "TEMPERATURE_OUT_OF_RANGE"
  | "MAX_OUTPUT_TOKENS_INVALID"
  | "TOOL_CHOICE_NO_TOOLS"
  | "TOOL_CHOICE_UNKNOWN_TOOL"
  | "PROVIDER_ERROR"
  | "AUTH_ERROR"
  | "STREAM_ERROR"
  | "MAPPING_ERROR"
  | "STREAM_INCOMPLETE"
  | "LOOKUP_FAILED"
  | "LOOKUP_TIMEOUT"
  | string;

export class AIError extends Error {
  override readonly name: string;

  constructor(
    message: string,
    public readonly code: ErrorCode,
    name?: string,
  ) {
    super(message);
    this.name = name ?? "AIError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 请求构造失败 — 参数校验不通过。在进入 adapter 前同步抛错。 */
export class AIRequestError extends AIError {
  constructor(
    message: string,
    code: ErrorCode,
    public readonly issues?: readonly { field: string; code: string; message: string }[],
  ) {
    super(message, code, "AIRequestError");
  }
}

/** Provider 调用失败 — HTTP 非 2xx、网络错误。由 AdapterBase 捕获转为 warning。 */
export class AIProviderError extends AIError {
  constructor(
    message: string,
    code: ErrorCode,
    public readonly statusCode?: number,
    public readonly responseBody?: string,
  ) {
    super(message, code, "AIProviderError");
  }
}

/** 流协议损坏 — SSE 解析失败、chunk 格式异常。 */
export class AIStreamError extends AIError {
  constructor(message: string, code: ErrorCode) {
    super(message, code, "AIStreamError");
  }
}

/** Canonical 映射失败 — 无法将 provider 响应映射到 canonical 类型。 */
export class AIMappingError extends AIError {
  constructor(message: string, code: ErrorCode) {
    super(message, code, "AIMappingError");
  }
}

// ── Warning 辅助 ──────────────────────────────────────────────

/**
 * 标准 warning 代码列表。
 * 用于非致命差异的记录。
 */
export const WarningCode = {
  /** replay fidelity 低于预期 */
  REPLAY_FIDELITY_LOW: "REPLAY_FIDELITY_LOW",
  /** usage 字段缺失 */
  USAGE_MISSING: "USAGE_MISSING",
  /** billing 字段缺失 */
  BILLING_MISSING: "BILLING_MISSING",
  /** billing 只能给估算值 */
  BILLING_ESTIMATED: "BILLING_ESTIMATED",
  /** follow-up lookup 失败 */
  LOOKUP_FAILED: "LOOKUP_FAILED",
  /** lookup 超时 */
  LOOKUP_TIMEOUT: "LOOKUP_TIMEOUT",
  /** 流提前中断 */
  STREAM_INCOMPLETE: "STREAM_INCOMPLETE",
  /** 能力降级 */
  CAPABILITY_DOWNGRADE: "CAPABILITY_DOWNGRADE",
  /** 模拟流式 */
  SYNTHETIC_STREAM: "SYNTHETIC_STREAM",
  /** 工具调用以批量方式到达（非 token 级流式） */
  TOOL_CALL_BATCHED: "TOOL_CALL_BATCHED",
} as const;
