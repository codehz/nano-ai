/**
 * Provider JSON 解析小工具
 *
 * - loose：出站 opaque / wire best-effort，失败回退 {}
 * - strict：失败抛 AIRequestError；入站 tool_call 参数经 `parseToolArguments` 再包装为 AIRecoverableError
 */

import { AIRequestError, type ErrorCode } from "../runtime/errors.js";

/** 宽松解析 JSON object：失败或非 object 返回 {}。 */
export function parseJsonLooseObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

/** 严格解析 JSON object：失败或非 object 抛 AIRequestError。 */
export function parseJsonStrictObject(
  text: string,
  message: string,
  code: ErrorCode = "TOOL_CALL_ARGUMENTS_INVALID",
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new AIRequestError(message, code);
}
