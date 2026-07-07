/**
 * 请求校验
 *
 * 在请求进入 adapter 前对参数合法性做基础检查。
 * 校验失败时抛 AIRequestError。
 */

import type { AIRequest } from "../types/index.js";
import { AIRequestError } from "./errors.js";

export type ValidationIssue = {
  field: string;
  code: string;
  message: string;
};

/**
 * 校验 AIRequest，返回校验问题列表。
 * 空数组表示无问题。
 */
export function validateRequest(request: AIRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // input 非空约束
  if (!request.input || request.input.length === 0) {
    issues.push({
      field: "input",
      code: "INPUT_EMPTY",
      message: "input must be a non-empty array",
    });
  }

  // input 元素类型检查
  if (request.input) {
    for (let i = 0; i < request.input.length; i++) {
      const item = request.input[i];
      if (!item || typeof item !== "object") {
        issues.push({
          field: `input[${i}]`,
          code: "INPUT_INVALID_ITEM",
          message: `input[${i}] must be a valid InputItem`,
        });
      }
    }
  }

  // temperature 范围
  if (request.temperature !== undefined) {
    if (typeof request.temperature !== "number" || isNaN(request.temperature)) {
      issues.push({
        field: "temperature",
        code: "TEMPERATURE_NOT_NUMBER",
        message: "temperature must be a number",
      });
    } else if (request.temperature < 0 || request.temperature > 2) {
      issues.push({
        field: "temperature",
        code: "TEMPERATURE_OUT_OF_RANGE",
        message: "temperature must be between 0 and 2",
      });
    }
  }

  // maxOutputTokens 合法性
  if (request.maxOutputTokens !== undefined) {
    if (typeof request.maxOutputTokens !== "number" || isNaN(request.maxOutputTokens)) {
      issues.push({
        field: "maxOutputTokens",
        code: "MAX_OUTPUT_TOKENS_NOT_NUMBER",
        message: "maxOutputTokens must be a number",
      });
    } else if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) {
      issues.push({
        field: "maxOutputTokens",
        code: "MAX_OUTPUT_TOKENS_INVALID",
        message: "maxOutputTokens must be a positive integer",
      });
    }
  }

  // toolChoice 与 tools 的一致性
  if (
    request.toolChoice &&
    typeof request.toolChoice === "object" &&
    "type" in request.toolChoice &&
    request.toolChoice.type === "tool"
  ) {
    const chosenName = request.toolChoice.name;
    if (!request.tools || request.tools.length === 0) {
      issues.push({
        field: "toolChoice",
        code: "TOOL_CHOICE_NO_TOOLS",
        message: `toolChoice specifies tool "${chosenName}" but no tools are defined`,
      });
    } else if (!request.tools.some((t) => t.name === chosenName)) {
      issues.push({
        field: "toolChoice",
        code: "TOOL_CHOICE_UNKNOWN_TOOL",
        message: `toolChoice specifies tool "${chosenName}" which is not in tools array`,
      });
    }
  }

  return issues;
}

/**
 * 校验请求并抛出首个问题。
 * 适用于客户端入口的快速失败检查。
 */
export function assertValidRequest(request: AIRequest): void {
  const issues = validateRequest(request);
  const first = issues[0];
  if (first) {
    throw new AIRequestError(first.message, first.code);
  }
}
