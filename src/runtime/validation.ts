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

const MESSAGE_ROLES = new Set(["user", "assistant"]);
const REASONING_VISIBILITIES = new Set(["full", "summary", "redacted", "opaque"]);
const TOOL_RESULT_OUTCOMES = new Set(["success", "error", "rejected"]);
const INCLUDE_MODES = new Set(["off", "best_effort"]);
const REASONING_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

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

function validateInstructionArray(content: unknown, field: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(content)) {
    pushIssue(issues, field, "INSTRUCTIONS_INVALID", `${field} must be an InstructionBlock[]`);
    return;
  }

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    const blockField = `${field}[${i}]`;
    validateContentBlock(block, blockField, issues);

    if (!isRecord(block) || typeof block.type !== "string") continue;
    if (block.type !== "text" && block.type !== "json") {
      pushIssue(issues, blockField, "INSTRUCTIONS_INVALID", `${blockField} only supports text/json blocks`);
    }
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
    case "server_tool_call":
      if (typeof item.id !== "string" || item.id.length === 0) {
        pushIssue(issues, `${field}.id`, "SERVER_TOOL_CALL_INVALID", `${field}.id must be a non-empty string`);
      }
      if (typeof item.tool !== "string" || item.tool.length === 0) {
        pushIssue(issues, `${field}.tool`, "SERVER_TOOL_CALL_INVALID", `${field}.tool must be a non-empty string`);
      }
      if (item.argumentsText !== undefined && typeof item.argumentsText !== "string") {
        pushIssue(
          issues,
          `${field}.argumentsText`,
          "SERVER_TOOL_CALL_INVALID",
          `${field}.argumentsText must be a string`,
        );
      }
      return;
    case "server_tool_result":
      if (typeof item.callId !== "string" || item.callId.length === 0) {
        pushIssue(
          issues,
          `${field}.callId`,
          "SERVER_TOOL_RESULT_INVALID",
          `${field}.callId must be a non-empty string`,
        );
      }
      if (typeof item.tool !== "string" || item.tool.length === 0) {
        pushIssue(issues, `${field}.tool`, "SERVER_TOOL_RESULT_INVALID", `${field}.tool must be a non-empty string`);
      }
      if (item.outcome !== "success" && item.outcome !== "error") {
        pushIssue(
          issues,
          `${field}.outcome`,
          "SERVER_TOOL_RESULT_INVALID",
          `${field}.outcome must be success or error`,
        );
      }
      validateContentArray(item.content, `${field}.content`, issues, "SERVER_TOOL_RESULT_INVALID");
      return;
    case "server_tool_discovery":
      if (typeof item.id !== "string" || item.id.length === 0) {
        pushIssue(issues, `${field}.id`, "SERVER_TOOL_DISCOVERY_INVALID", `${field}.id must be a non-empty string`);
      }
      if (item.tool !== "mcp") {
        pushIssue(issues, `${field}.tool`, "SERVER_TOOL_DISCOVERY_INVALID", `${field}.tool must be "mcp"`);
      }
      if (typeof item.serverLabel !== "string" || item.serverLabel.length === 0) {
        pushIssue(
          issues,
          `${field}.serverLabel`,
          "SERVER_TOOL_DISCOVERY_INVALID",
          `${field}.serverLabel must be a non-empty string`,
        );
      }
      if (!Array.isArray(item.tools)) {
        pushIssue(issues, `${field}.tools`, "SERVER_TOOL_DISCOVERY_INVALID", `${field}.tools must be an array`);
      }
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
      } else {
        try {
          const parsed: unknown = JSON.parse(item.argumentsText);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            pushIssue(
              issues,
              `${field}.argumentsText`,
              "TOOL_CALL_ARGUMENTS_INVALID",
              `${field}.argumentsText must encode a JSON object`,
            );
          }
        } catch {
          pushIssue(
            issues,
            `${field}.argumentsText`,
            "TOOL_CALL_ARGUMENTS_INVALID",
            `${field}.argumentsText must encode a JSON object`,
          );
        }
      }
      return;
    case "tool_result":
      if (typeof item.callId !== "string" || item.callId.length === 0) {
        pushIssue(
          issues,
          `${field}.callId`,
          "TOOL_RESULT_CALL_ID_INVALID",
          `${field}.callId must be a non-empty string`,
        );
      }
      if (typeof item.toolName !== "string" || item.toolName.length === 0) {
        pushIssue(
          issues,
          `${field}.toolName`,
          "TOOL_RESULT_NAME_INVALID",
          `${field}.toolName must be a non-empty string`,
        );
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
      pushIssue(issues, `${field}.inputSchema`, "TOOL_INPUT_SCHEMA_INVALID", `${field}.inputSchema must be an object`);
    }
  }
}

const SEARCH_CONTEXT_SIZES = new Set(["low", "medium", "high"]);
const CODE_MEMORY_LIMITS = new Set(["1g", "4g", "16g", "64g"]);

function validateStringArrayField(
  value: unknown,
  field: string,
  code: string,
  issues: ValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    pushIssue(issues, field, code, `${field} must be a string array`);
    return;
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string" || value[i].length === 0) {
      pushIssue(issues, `${field}[${i}]`, code, `${field}[${i}] must be a non-empty string`);
    }
  }
}

function validateServerTools(serverTools: unknown, issues: ValidationIssue[]): void {
  if (serverTools === undefined) return;
  if (!Array.isArray(serverTools)) {
    pushIssue(issues, "serverTools", "SERVER_TOOLS_INVALID", "serverTools must be an array");
    return;
  }

  for (let i = 0; i < serverTools.length; i++) {
    const tool = serverTools[i];
    const field = `serverTools[${i}]`;
    if (!isRecord(tool) || typeof tool.type !== "string") {
      pushIssue(issues, field, "SERVER_TOOL_INVALID", `${field} must be a valid ServerToolDefinition`);
      continue;
    }

    switch (tool.type) {
      case "web_search": {
        if (tool.allowedDomains !== undefined && tool.blockedDomains !== undefined) {
          pushIssue(
            issues,
            field,
            "SERVER_TOOL_WEB_SEARCH_DOMAINS_CONFLICT",
            `${field} cannot set both allowedDomains and blockedDomains`,
          );
        }
        if (tool.allowedDomains !== undefined) {
          validateStringArrayField(tool.allowedDomains, `${field}.allowedDomains`, "SERVER_TOOL_INVALID", issues);
        }
        if (tool.blockedDomains !== undefined) {
          validateStringArrayField(tool.blockedDomains, `${field}.blockedDomains`, "SERVER_TOOL_INVALID", issues);
        }
        if (tool.searchContextSize !== undefined) {
          if (typeof tool.searchContextSize !== "string" || !SEARCH_CONTEXT_SIZES.has(tool.searchContextSize)) {
            pushIssue(
              issues,
              `${field}.searchContextSize`,
              "SERVER_TOOL_INVALID",
              `${field}.searchContextSize must be low, medium, or high`,
            );
          }
        }
        if (tool.userLocation !== undefined) {
          if (!isRecord(tool.userLocation) || tool.userLocation.type !== "approximate") {
            pushIssue(
              issues,
              `${field}.userLocation`,
              "SERVER_TOOL_INVALID",
              `${field}.userLocation must be { type: "approximate", ... }`,
            );
          } else {
            for (const key of ["country", "city", "region", "timezone"] as const) {
              const value = tool.userLocation[key];
              if (value !== undefined && typeof value !== "string") {
                pushIssue(
                  issues,
                  `${field}.userLocation.${key}`,
                  "SERVER_TOOL_INVALID",
                  `${field}.userLocation.${key} must be a string`,
                );
              }
            }
          }
        }
        break;
      }
      case "code_execution": {
        if (tool.container !== undefined) {
          if (!isRecord(tool.container) || tool.container.type !== "auto") {
            pushIssue(
              issues,
              `${field}.container`,
              "SERVER_TOOL_INVALID",
              `${field}.container must be { type: "auto", ... }`,
            );
          } else {
            if (tool.container.memoryLimit !== undefined) {
              if (
                typeof tool.container.memoryLimit !== "string" ||
                !CODE_MEMORY_LIMITS.has(tool.container.memoryLimit)
              ) {
                pushIssue(
                  issues,
                  `${field}.container.memoryLimit`,
                  "SERVER_TOOL_INVALID",
                  `${field}.container.memoryLimit must be 1g, 4g, 16g, or 64g`,
                );
              }
            }
            if (tool.container.fileIds !== undefined) {
              validateStringArrayField(
                tool.container.fileIds,
                `${field}.container.fileIds`,
                "SERVER_TOOL_INVALID",
                issues,
              );
            }
          }
        }
        break;
      }
      case "mcp": {
        if (typeof tool.serverLabel !== "string" || tool.serverLabel.length === 0) {
          pushIssue(
            issues,
            `${field}.serverLabel`,
            "SERVER_TOOL_INVALID",
            `${field}.serverLabel must be a non-empty string`,
          );
        }
        if (typeof tool.serverUrl !== "string" || tool.serverUrl.length === 0) {
          pushIssue(
            issues,
            `${field}.serverUrl`,
            "SERVER_TOOL_INVALID",
            `${field}.serverUrl must be a non-empty string`,
          );
        }
        if (tool.serverDescription !== undefined && typeof tool.serverDescription !== "string") {
          pushIssue(
            issues,
            `${field}.serverDescription`,
            "SERVER_TOOL_INVALID",
            `${field}.serverDescription must be a string`,
          );
        }
        if (tool.authorization !== undefined && typeof tool.authorization !== "string") {
          pushIssue(
            issues,
            `${field}.authorization`,
            "SERVER_TOOL_INVALID",
            `${field}.authorization must be a string`,
          );
        }
        if (tool.allowedTools !== undefined) {
          validateStringArrayField(tool.allowedTools, `${field}.allowedTools`, "SERVER_TOOL_INVALID", issues);
        }
        if (tool.requireApproval !== "never") {
          pushIssue(
            issues,
            `${field}.requireApproval`,
            "SERVER_TOOL_MCP_APPROVAL_UNSUPPORTED",
            `${field}.requireApproval must be "never" in this version`,
          );
        }
        break;
      }
      default:
        pushIssue(
          issues,
          `${field}.type`,
          "SERVER_TOOL_TYPE_UNSUPPORTED",
          `${field}.type "${tool.type}" is not supported`,
        );
    }
  }
}

function validateToolChoice(toolChoice: unknown, issues: ValidationIssue[]): void {
  if (toolChoice === undefined) return;
  if (toolChoice === "auto" || toolChoice === "none") return;
  if (
    !isRecord(toolChoice) ||
    toolChoice.type !== "tool" ||
    typeof toolChoice.name !== "string" ||
    toolChoice.name.length === 0
  ) {
    pushIssue(issues, "toolChoice", "TOOL_CHOICE_INVALID", 'toolChoice must be auto, none, or { type: "tool", name }');
  }
}

/** Validate include settings, appending issues to the given array. */
export function validateInclude(include: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(include)) {
    pushIssue(issues, "include", "INCLUDE_INVALID", "include must be an object");
    return;
  }
  if (include.usage !== undefined && (typeof include.usage !== "string" || !INCLUDE_MODES.has(include.usage))) {
    pushIssue(issues, "include.usage", "INCLUDE_USAGE_INVALID", "include.usage must be off or best_effort");
  }
  if (include.billing !== undefined && (typeof include.billing !== "string" || !INCLUDE_MODES.has(include.billing))) {
    pushIssue(issues, "include.billing", "INCLUDE_BILLING_INVALID", "include.billing must be off or best_effort");
  }
  if (
    include.providerMetadata !== undefined &&
    (typeof include.providerMetadata !== "string" || !INCLUDE_MODES.has(include.providerMetadata))
  ) {
    pushIssue(
      issues,
      "include.providerMetadata",
      "INCLUDE_PROVIDER_METADATA_INVALID",
      "include.providerMetadata must be off or best_effort",
    );
  }
}

/**
 * 校验 AIRequest，返回校验问题列表。
 * 空数组表示无问题。
 */
export function validateRequest(request: AIRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (request.instructions !== undefined) {
    if (typeof request.instructions === "string") {
      // no-op
    } else if (Array.isArray(request.instructions)) {
      validateInstructionArray(request.instructions, "instructions", issues);
    } else {
      pushIssue(issues, "instructions", "INSTRUCTIONS_INVALID", "instructions must be a string or InstructionBlock[]");
    }
  }

  // input 非空约束
  if (!Array.isArray(request.input) || request.input.length === 0) {
    pushIssue(issues, "input", "INPUT_EMPTY", "input must be a non-empty array");
  }

  // input 元素类型检查
  if (Array.isArray(request.input)) {
    for (let i = 0; i < request.input.length; i++) {
      validateInputItem(request.input[i], `input[${i}]`, issues);
    }
  }

  // temperature 范围
  if (request.temperature !== undefined) {
    if (typeof request.temperature !== "number" || !Number.isFinite(request.temperature)) {
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
    if (typeof request.maxOutputTokens !== "number" || !Number.isFinite(request.maxOutputTokens)) {
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

  // reasoningLevel 枚举
  if (request.reasoningLevel !== undefined) {
    if (typeof request.reasoningLevel !== "string" || !REASONING_LEVELS.has(request.reasoningLevel)) {
      pushIssue(
        issues,
        "reasoningLevel",
        "REASONING_LEVEL_INVALID",
        "reasoningLevel must be one of: none, minimal, low, medium, high, xhigh, max",
      );
    }
  }

  if (request.include !== undefined) {
    validateInclude(request.include, issues);
  }

  if (request.metadata !== undefined) {
    if (!isRecord(request.metadata)) {
      pushIssue(issues, "metadata", "METADATA_INVALID", "metadata must be an object");
    } else {
      for (const [key, value] of Object.entries(request.metadata)) {
        if (typeof value !== "string") {
          pushIssue(issues, `metadata.${key}`, "METADATA_VALUE_INVALID", `metadata.${key} must be a string`);
        }
      }
    }
  }

  validateTools(request.tools, issues);
  validateServerTools(request.serverTools, issues);
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
    throw new AIRequestError(first.message, first.code, issues);
  }
}
