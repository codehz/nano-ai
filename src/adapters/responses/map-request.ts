/**
 * NormalizedRequest → Responses API 请求体（不含 extraBody 合并）
 */

import { AIRequestError } from "../../runtime/errors.js";
import { acceptOpaqueReplay } from "../../provider/opaque-replay.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";
import { mapResponsesReasoning } from "../../provider/reasoning.js";
import { OPAQUE_SOURCE } from "../../provider/opaque-sources.js";
import type { ContentBlock, NormalizedRequest, ReasoningItem } from "../../types/index.js";
import { mapServerTools } from "./map-server-tools.js";
import type {
  ResponsesAPIRequest,
  ResponsesInputItem,
  ResponsesReasoningInput,
  ResponsesTool,
} from "./types.js";

const mapper = new NormalizedRequestMapper("responses");

function isReplayCanonicalInput(item: ResponsesInputItem): boolean {
  return (
    (item.type === "message" && item.role === "assistant") || item.type === "reasoning" || item.type === "function_call"
  );
}

function hasReplayCanonicalInput(input: ResponsesInputItem[]): boolean {
  return input.some(isReplayCanonicalInput);
}

function readNonEmptyString(value: unknown, maxLen = 256): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLen) return undefined;
  return value;
}

/** 将 canonical text/json blocks 压成 EasyInputMessage 的 string content。 */
function messageContentAsString(blocks: ContentBlock[], field: string): string {
  return mapper.textFromBlocks(blocks, field);
}

function mapReasoningInput(item: ReasoningItem, index: number): ResponsesReasoningInput {
  const text = mapper.textFromBlocks(
    mapper.ensureReasoningBlocks(item.content, "reasoning content"),
    "reasoning content",
  );
  const id = item.id && item.id.length > 0 ? item.id : `reasoning_replay_${index}`;

  if (item.visibility === "full") {
    return {
      type: "reasoning",
      id,
      summary: [],
      content: text ? [{ type: "reasoning_text", text }] : undefined,
    };
  }

  // summary / redacted / opaque：公开可回传的是 summary_text
  return {
    type: "reasoning",
    id,
    summary: text ? [{ type: "summary_text", text }] : [],
  };
}

function extractOpaqueContinuationId(payload: Record<string, unknown>): {
  previousResponseId?: string;
  itemReferenceId?: string;
} {
  // 优先显式 previous_response_id；历史 payload 用 id 存 response 续写句柄
  const previousResponseId =
    readNonEmptyString(payload.previous_response_id) ??
    (typeof payload.item_id === "string" ? undefined : readNonEmptyString(payload.id));

  // 仅在显式给出 item_id 时使用 item_reference（引用的是 item，不是 response）
  const itemReferenceId = readNonEmptyString(payload.item_id);

  return { previousResponseId, itemReferenceId };
}

/** 构建 Responses 请求体；调用方再 `withExtraBody` 合并构造期扩展字段。 */
export function buildResponsesRequest(request: NormalizedRequest): ResponsesAPIRequest {
  const input: ResponsesInputItem[] = [];
  let previousResponseId: string | undefined;
  let reasoningIndex = 0;

  for (const item of request.input) {
    switch (item.type) {
      case "message": {
        // EasyInputMessage：string content 对 user/assistant 都合法，且最不易触发 ModelInput 反序列化失败。
        // 切勿发送 { type: "text" } —— 官方 content part 是 input_text / output_text。
        input.push({
          type: "message",
          role: item.role,
          content: messageContentAsString(item.content, `input message (${item.role}) content`),
        });
        break;
      }
      case "reasoning": {
        input.push(mapReasoningInput(item, reasoningIndex++));
        break;
      }
      case "tool_call": {
        // call_id 必填；canonical ToolCallItem.id 即 call_id（流里会优先取 call_id）
        input.push({
          type: "function_call",
          call_id: item.id,
          name: item.name,
          arguments: item.argumentsText,
        });
        break;
      }
      case "tool_result": {
        const output = mapper.textFromBlocks(item.content, `tool_result ${item.callId} content`);
        input.push({
          type: "function_call_output",
          call_id: item.callId,
          output,
        });
        break;
      }
      case "opaque": {
        // Canonical replay 优先；否则用 previous_response_id 做服务端续写。
        // 注意：response id 不能塞进 item_reference（那是 item id）；不叠 wire assistant。
        const payload = acceptOpaqueReplay(item, OPAQUE_SOURCE.RESPONSES);
        if (!payload) break;

        // 显式字段校验：id / previous_response_id / item_id 若存在必须是合法 string
        for (const key of ["id", "previous_response_id", "item_id"] as const) {
          if (
            key in payload &&
            (typeof payload[key] !== "string" || payload[key].length === 0 || payload[key].length > 256)
          ) {
            throw new AIRequestError(
              `Invalid opaque replay payload: ${key} must be a non-empty string (max 256)`,
              "INVALID_OPAQUE_REPLAY",
            );
          }
        }

        const { previousResponseId: prevId, itemReferenceId } = extractOpaqueContinuationId(payload);
        if (!hasReplayCanonicalInput(input)) {
          if (prevId && !previousResponseId) {
            previousResponseId = prevId;
          } else if (itemReferenceId) {
            input.push({ type: "item_reference", id: itemReferenceId });
          }
        }
        break;
      }
    }
  }

  const body: ResponsesAPIRequest = {
    model: request.model,
    input,
    stream: true,
  };

  if (previousResponseId) {
    body.previous_response_id = previousResponseId;
  }

  if (request.instructions) {
    body.instructions = mapper.mapInstructions(request.instructions);
  }

  const functionTools =
    mapper.mapToolsIfPresent(
      request.tools,
      (t): ResponsesTool => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      }),
    ) ?? [];
  const serverTools = mapServerTools(request.serverTools);
  const tools = [...functionTools, ...serverTools];
  if (tools.length > 0) {
    body.tools = tools;
  }

  body.tool_choice = mapper.mapToolChoice<Exclude<ResponsesAPIRequest["tool_choice"], undefined>>(
    request.toolChoice,
    {
      auto: "auto",
      none: "none",
      tool: (name) => ({ type: "function" as const, name }),
    },
  );

  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
  if (request.metadata) body.metadata = request.metadata;
  if (request.reasoningLevel !== undefined) {
    body.reasoning = mapResponsesReasoning(request.reasoningLevel);
  }

  return body;
}
