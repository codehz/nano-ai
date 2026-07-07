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

const MESSAGE_ROLES = new Set(["user", "assistant", "system", "developer"]);
const REASONING_VISIBILITIES = new Set(["full", "summary", "redacted", "opaque"]);
const TOOL_RESULT_OUTCOMES = new Set(["success", "error", "rejected"]);
const INCLUDE_MODES = new Set(["off", "best_effort"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pushIssue(issues: ValidationIssue[], field: string, code: string, message: string): void {
  issues.push({ field, code, message });
}

function validateContentBlock(block: unknown, field: string, issues: ValidationIssue[]): void {
  if (!isRecord(block) || typeof block.type !== "string") {
    pushIssue(issues, field, "CONTENT_BLOCK_INVALID", `${field} must be a valid ContentBlock`);
    return;
  }

  switch (block.type) {
    case "text":
      if (typeof block.text !== "string") {
        pushIssue(issues, field, "CONTENT_BLOCK_INVALID", `${field}.text must be a string`);
      }
      return;
    case "json":
      if (!("json" in block)) {
        pushIssue(issues, field, "CONTENT_BLOCK_INVALID", `${field}.json must be present`);
      }
      return;
    case "image":
      if (typeof block.imageUrl !== "string" || block.imageUrl.length === 0) {
        pushIssue(issues, field, "CONTENT_BLOCK_INVALID", `${field}.imageUrl must be a non-empty string`);
      }
      return;
    case "binary_ref":
      if (typeof block.ref !== "string" || block.ref.length === 0) {
        pushIssue(issues, field, "CONTENT_BLOCK_INVALID", `${field}.ref must be a non-empty string`);
      }
      return;
    case "opaque":
      if (!("payload" in block)) {
        pushIssue(issues, field, "CONTENT_BLOCK_INVALID", `${field}.payload must be present`);
      }
      return;
    default:
      pushIssue(issues, field, "CONTENT_BLOCK_INVALID", `${field}.type "${block.type}" is not supported`);
  }
}

function validateContentArray(content: unknown, field: string, issues: ValidationIssue[], code: string): void {
  if (!Array.isArray(content)) {
    pushIssue(issues, field, code, `${field} must be a ContentBlock[]`);
    return;
  }

  for (let i = 0; i < content.length; i++) {
    validateContentBlock(content[i], `${field}[${i}]`, issues);
  }
}

function validateInputItem(item: unknown, field: string, issues: ValidationIssue[]): void {
  if (!isRecord(item)) {
    pushIssue(issues, field, "INPUT_INVALID_ITEM", `${field} must be a valid InputItem`);
    return;
  }

  if (typeof item.type !== "string") {
    pushIssue(issues, field, "INPUT_ITEM_UNKNOWN_TYPE", `${field}.type must be a supported InputItem type`);
    return;
  }

  switch (item.type) {
    case "message":
      if (typeof item.role !== "string" || !MESSAGE_ROLES.has(item.role)) {
        pushIssue(issues, `${field}.role`, "MESSAGE_ROLE_INVALID", `${field}.role must be a valid message role`);
      }
      validateContentArray(item.content, `${field}.content`, issues, "MESSAGE_CONTENT_INVALID");
      return;
    case "reasoning":
      if (typeof item.visibility !== "string" || !REASONING_VISIBILITIES.has(item.visibility)) {
        pushIssue(
          issues,
          `${field}.visibility`,
          "REASONING_VISIBILITY_INVALID",
          `${field}.visibility must be a valid reasoning visibility`,
        );
      }
      validateContentArray(item.content, `${field}.content`, issues, "REASONING_CONTENT_INVALID");
      return;
    case "tool_call":
      if (typeof item.id !== "string" || item.id.length === 0) {
        pushIssue(issues, `${field}.id`, "TOOL_CALL_ID_INVALID", `${field}.id must be a non-empty string`);
      }
      if (typeof item.name !== "string" || item.name.length === 0) {
        pushIssue(issues, `${field}.name`, "TOOL_CALL_NAME_INVALID", `${field}.name must be a non-empty string`);
      }
      if (typeof item.argumentsText !== "string") {
        pushIssue(
          issues,
          `${field}.argumentsText`,
          "TOOL_CALL_ARGUMENTS_INVALID",
          `${field}.argumentsText must be a string`,
        );
      }
      return;
    case "tool_result":
      if (typeof item.callId !== "string" || item.callId.length === 0) {
        pushIssue(issues, `${field}.callId`, "TOOL_RESULT_CALL_ID_INVALID", `${field}.callId must be a non-empty string`);
      }
      if (typeof item.toolName !== "string" || item.toolName.length === 0) {
        pushIssue(issues, `${field}.toolName`, "TOOL_RESULT_NAME_INVALID", `${field}.toolName must be a non-empty string`);
      }
      if (typeof item.outcome !== "string" || !TOOL_RESULT_OUTCOMES.has(item.outcome)) {
        pushIssue(
          issues,
          `${field}.outcome`,
          "TOOL_RESULT_OUTCOME_INVALID",
          `${field}.outcome must be success, error, or rejected`,
        );
      }
      validateContentArray(item.content, `${field}.content`, issues, "TOOL_RESULT_CONTENT_INVALID");
      return;
    case "opaque":
      if (typeof item.source !== "string" || item.source.length === 0) {
        pushIssue(issues, `${field}.source`, "OPAQUE_SOURCE_INVALID", `${field}.source must be a non-empty string`);
      }
      if (typeof item.purpose !== "string" || item.purpose.length === 0) {
        pushIssue(issues, `${field}.purpose`, "OPAQUE_PURPOSE_INVALID", `${field}.purpose must be a non-empty string`);
      }
      return;
    default:
      pushIssue(issues, `${field}.type`, "INPUT_ITEM_UNKNOWN_TYPE", `${field}.type "${item.type}" is not supported`);
  }
}

function validateTools(tools: unknown, issues: ValidationIssue[]): void {
  if (tools === undefined) return;
  if (!Array.isArray(tools)) {
    pushIssue(issues, "tools", "TOOLS_INVALID", "tools must be an array");
    return;
  }

  const seenNames = new Set<string>();
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    const field = `tools[${i}]`;
    if (!isRecord(tool)) {
      pushIssue(issues, field, "TOOL_INVALID", `${field} must be a valid ToolDefinition`);
      continue;
    }

    if (typeof tool.name !== "string" || tool.name.length === 0) {
      pushIssue(issues, `${field}.name`, "TOOL_NAME_INVALID", `${field}.name must be a non-empty string`);
    } else {
      if (seenNames.has(tool.name)) {
        pushIssue(issues, `${field}.name`, "TOOLS_DUPLICATE_NAME", `tool name "${tool.name}" is duplicated`);
      }
      seenNames.add(tool.name);
    }

    if (tool.description !== undefined && typeof tool.description !== "string") {
      pushIssue(issues, `${field}.description`, "TOOL_DESCRIPTION_INVALID", `${field}.description must be a string`);
    }

    if (!isRecord(tool.inputSchema)) {
      pushIssue(
        issues,
        `${field}.inputSchema`,
        "TOOL_INPUT_SCHEMA_INVALID",
        `${field}.inputSchema must be an object`,
      );
    }
  }
}

function validateToolChoice(toolChoice: unknown, issues: ValidationIssue[]): void {
  if (toolChoice === undefined) return;
  if (toolChoice === "auto" || toolChoice === "none") return;
  if (!isRecord(toolChoice) || toolChoice.type !== "tool" || typeof toolChoice.name !== "string" || toolChoice.name.length === 0) {
    pushIssue(issues, "toolChoice", "TOOL_CHOICE_INVALID", "toolChoice must be auto, none, or { type: \"tool\", name }");
  }
}

/**
 * 校验 AIRequest，返回校验问题列表。
 * 空数组表示无问题。
 */
export function validateRequest(request: AIRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (request.instructions !== undefined && Array.isArray(request.instructions)) {
    validateContentArray(request.instructions, "instructions", issues, "INSTRUCTIONS_INVALID");
  }

  // input 非空约束
  if (!request.input || request.input.length === 0) {
    pushIssue(issues, "input", "INPUT_EMPTY", "input must be a non-empty array");
  }

  // input 元素类型检查
  if (request.input) {
    for (let i = 0; i < request.input.length; i++) {
      validateInputItem(request.input[i], `input[${i}]`, issues);
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

  if (request.include) {
    if (request.include.usage !== undefined && !INCLUDE_MODES.has(request.include.usage)) {
      pushIssue(issues, "include.usage", "INCLUDE_USAGE_INVALID", "include.usage must be off or best_effort");
    }
    if (request.include.billing !== undefined && !INCLUDE_MODES.has(request.include.billing)) {
      pushIssue(issues, "include.billing", "INCLUDE_BILLING_INVALID", "include.billing must be off or best_effort");
    }
    if (request.include.providerMetadata !== undefined && !INCLUDE_MODES.has(request.include.providerMetadata)) {
      pushIssue(
        issues,
        "include.providerMetadata",
        "INCLUDE_PROVIDER_METADATA_INVALID",
        "include.providerMetadata must be off or best_effort",
      );
    }
  }

  if (request.metadata) {
    for (const [key, value] of Object.entries(request.metadata)) {
      if (typeof value !== "string") {
        pushIssue(issues, `metadata.${key}`, "METADATA_VALUE_INVALID", `metadata.${key} must be a string`);
      }
    }
  }

  validateTools(request.tools, issues);
  validateToolChoice(request.toolChoice, issues);

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
