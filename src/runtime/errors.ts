/**
 * 公共错误模型
 *
 * 把失败、降级、断流三类情况明确区分：
 * - 致命错误（AIRequestError / AIProviderError / AIStreamError）→ 同步抛错或迭代器抛错
 * - AIMappingError → AdapterBase 捕获后降级为 response.warning + 空 output 的 response.completed
 * - 非致命差异 → warning 通道（WarningCode）
 * - 流中断 → 不伪造 response.completed
 */

// ── 错误类型 ──────────────────────────────────────────────────

/**
 * 已知错误码。保留补全；未知码用 `string & {}` 扩展，避免 `| string` 吞掉字面量提示。
 * ValidationIssue.code 可更细，不强制全部列入此处；以作为 AIError.code 传入的码为主。
 */
export type KnownErrorCode =
  | "INPUT_EMPTY"
  | "TEMPERATURE_OUT_OF_RANGE"
  | "MAX_OUTPUT_TOKENS_INVALID"
  | "TOOL_CHOICE_NO_TOOLS"
  | "TOOL_CHOICE_UNKNOWN_TOOL"
  | "TOOL_CALL_ARGUMENTS_INVALID"
  | "PROVIDER_ERROR"
  | "AUTH_ERROR"
  | "STREAM_ERROR"
  | "STREAM_PROTOCOL_ERROR"
  | "MAPPING_ERROR"
  | "STREAM_INCOMPLETE"
  | "LOOKUP_FAILED"
  | "LOOKUP_TIMEOUT"
  | "INVALID_OPAQUE_REPLAY"
  | "UNSUPPORTED_CONTENT_BLOCK"
  | "UNSUPPORTED_SERVER_TOOL"
  | "UNSUPPORTED_REASONING_LEVEL"
  | "MOCK_CONCURRENT_STREAM"
  | "MOCK_EXPECTATION_FAILED"
  | "MOCK_STREAM_CONFIG_INVALID"
  | "MOCK_OPAQUE_OUTPUT"
  | "MOCK_MESSAGE_ID_MISSING"
  | "MOCK_REASONING_ID_MISSING";

export type ErrorCode = KnownErrorCode | (string & {});

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

/**
 * Provider 调用失败 — HTTP 非 2xx、网络错误。
 * AdapterBase **rethrow**（致命），不会转为 warning。
 */
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

/**
 * 流协议/传输损坏 — SSE 解析失败、chunk 格式异常、body 不可读等。
 * 致命：同步或在异步迭代中抛出，不伪造 response.completed。
 */
export class AIStreamError extends AIError {
  constructor(message: string, code: ErrorCode) {
    super(message, code, "AIStreamError");
  }
}

/**
 * Canonical 映射失败 — 无法将 provider 响应映射到 canonical 类型。
 *
 * AdapterBase 捕获后降级为：
 * - `response.warning`（code = MAPPING_ERROR）
 * - 空 output 的 `response.completed`
 *
 * 生产 adapter 原则上不应抛出；此路径是协议级降级通道（测试 / 防御性边界）。
 */
export class AIMappingError extends AIError {
  constructor(message: string, code: ErrorCode) {
    super(message, code, "AIMappingError");
  }
}

// ── Warning 辅助（单源在 types/warning-codes）────────────────

export { WarningCode, streamWarningKey } from "../types/warning-codes.js";
export type {
  WarningCodeName,
  KnownWarningCode,
  WarningCodeValue,
  StreamWarning,
} from "../types/warning-codes.js";
