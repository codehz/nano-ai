/**
 * 标准 warning 代码 — types 层单源
 *
 * runtime.errors 与 events 均从此导出，避免手工双表漂移。
 */

/** 标准 warning 代码常量；事件和响应均可携带这些代码。 */
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
  /** 流帧/行解析失败 */
  STREAM_ERROR: "STREAM_ERROR",
  /** 能力降级 */
  CAPABILITY_DOWNGRADE: "CAPABILITY_DOWNGRADE",
  /** 模拟流式 */
  SYNTHETIC_STREAM: "SYNTHETIC_STREAM",
  /** 工具调用以批量方式到达（非 token 级流式） */
  TOOL_CALL_BATCHED: "TOOL_CALL_BATCHED",
  /** AIMappingError 降级为 warning */
  MAPPING_ERROR: "MAPPING_ERROR",
  /** 入站 tool_call.argumentsText 非合法 JSON object（object-wire adapter soft-complete） */
  TOOL_CALL_ARGUMENTS_INVALID: "TOOL_CALL_ARGUMENTS_INVALID",
  /** 请求 metadata 不被该 adapter 支持 */
  UNSUPPORTED_METADATA: "UNSUPPORTED_METADATA",
  /** 重复 finish / done 信号被忽略 */
  DUPLICATE_FINISH: "DUPLICATE_FINISH",
  /** provider 发出未知事件类型 */
  UNKNOWN_PROVIDER_EVENT: "UNKNOWN_PROVIDER_EVENT",
  /** 内容被安全/策略过滤 */
  CONTENT_FILTER: "CONTENT_FILTER",
  /** 多 choice 仅支持 index 0，其余忽略 */
  MULTIPLE_CHOICES_IGNORED: "MULTIPLE_CHOICES_IGNORED",
  /** MCP 审批流不被支持 */
  MCP_APPROVAL_REQUIRED: "MCP_APPROVAL_REQUIRED",
  /** provider 侧 response.failed 等失败 */
  PROVIDER_FAILURE: "PROVIDER_FAILURE",
  /** 出站 opaque 超限被省略（避免下一轮 accept 自产毒） */
  OPAQUE_REPLAY_OMITTED: "OPAQUE_REPLAY_OMITTED",
} as const;

export type WarningCodeName = (typeof WarningCode)[keyof typeof WarningCode];

/** 与 WarningCodeName 同义；保留以兼容既有 KnownWarningCode 命名 */
export type KnownWarningCode = WarningCodeName;

/** 已知码 + 开放字符串扩展 */
export type WarningCodeValue = KnownWarningCode | (string & {});

/** 结构化 warning（AIResponse / response.completed / factory 共用） */
export type StreamWarning = {
  message: string;
  code?: WarningCodeValue;
};

/**
 * 去重键：以 message 为主（与旧 string[] 行为一致）。
 * 同一 message 若先无 code 后有 code，保留先到的那条。
 */
export function streamWarningKey(warning: StreamWarning): string {
  return warning.message;
}
