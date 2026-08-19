/**
 * NormalizedRequest → Responses API 请求体（不含 extraBody 合并）
 *
 * 同时服务 stream（/responses）与 compress（/responses/compact）。
 */

import { AIRequestError } from "../../runtime/errors.js";
import { acceptOpaqueReplay } from "../../provider/opaque-replay.js";
import { applyPromptCacheFields } from "../../provider/prompt-cache.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";
import { mapResponsesReasoning } from "../../provider/reasoning.js";
import { OPAQUE_SOURCE } from "../../provider/opaque-sources.js";
import type {
  CompressRequest,
  ContentBlock,
  InputItem,
  InstructionBlock,
  NormalizedRequest,
  ReasoningItem,
} from "../../types/index.js";
import { mapServerTools } from "./map-server-tools.js";
import type {
  ResponsesAPIRequest,
  ResponsesCompactAPIRequest,
  ResponsesEasyMessage,
  ResponsesInputContentPart,
  ResponsesInputItem,
  ResponsesReasoningInput,
  ResponsesTool,
} from "./types.js";

const mapper = new NormalizedRequestMapper("responses");

/** compact replay opaque：整份 wire output window 保真回传 */
export const RESPONSES_COMPACTED_WINDOW_KIND = "compacted_window" as const;

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

/**
 * EasyInputMessage content：
 * - 非 user：继续 text/json → string
 * - user 且含 image：input_text / input_image parts（不发 detail）
 * - user 纯 text/json：仍发 string，避免无谓 shape churn
 */
function mapResponsesMessageContent(
  role: ResponsesEasyMessage["role"],
  blocks: ContentBlock[],
  field: string,
): string | ResponsesInputContentPart[] {
  if (role !== "user") {
    return mapper.textFromBlocks(blocks, field);
  }

  mapper.ensureBlocks(blocks, field, ["text", "json", "image"], "only text/json/image blocks are supported");
  const hasImage = blocks.some((block) => block.type === "image");
  if (!hasImage) {
    return mapper.textFromBlocks(blocks, field);
  }

  return blocks.map((block): ResponsesInputContentPart => {
    if (block.type === "text") return { type: "input_text", text: block.text };
    if (block.type === "json") return { type: "input_text", text: JSON.stringify(block.json) };
    if (block.type === "image") return { type: "input_image", image_url: block.imageUrl };
    throw new AIRequestError(
      `${mapper.kind} does not support ${field} block of type "${block.type}"; only text/json/image blocks are supported`,
      "UNSUPPORTED_CONTENT_BLOCK",
    );
  });
}

function mapResponsesToolResultOutput(blocks: ContentBlock[], field: string): string | ResponsesInputContentPart[] {
  mapper.ensureBlocks(blocks, field, ["text", "json", "image"], "only text/json/image blocks are supported");
  if (!blocks.some((block) => block.type === "image")) {
    return mapper.textFromBlocks(blocks, field);
  }

  return blocks.map((block): ResponsesInputContentPart => {
    if (block.type === "text") return { type: "input_text", text: block.text };
    if (block.type === "json") return { type: "input_text", text: JSON.stringify(block.json) };
    if (block.type === "image") return { type: "input_image", image_url: block.imageUrl };
    throw new AIRequestError(
      `${mapper.kind} does not support ${field} block of type "${block.type}"; only text/json/image blocks are supported`,
      "UNSUPPORTED_CONTENT_BLOCK",
    );
  });
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

function assertOptionalIdFields(payload: Record<string, unknown>): void {
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
}

/**
 * 将 compact 返回的 wire output 原样展开进 input。
 * 官方要求：不要裁剪 compact output；下轮 /responses 应整窗回传。
 */
function appendCompactedWindow(input: ResponsesInputItem[], payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.output)) {
    throw new AIRequestError(
      'Invalid opaque replay payload: compacted_window requires "output" array',
      "INVALID_OPAQUE_REPLAY",
    );
  }
  for (let i = 0; i < payload.output.length; i++) {
    const wireItem = payload.output[i];
    if (!wireItem || typeof wireItem !== "object") {
      throw new AIRequestError(
        `Invalid opaque replay payload: compacted_window.output[${i}] must be an object`,
        "INVALID_OPAQUE_REPLAY",
      );
    }
    // 保真：compact 输出按 wire 原样进入下一轮 input（含 compaction / retained messages）
    input.push(wireItem as ResponsesInputItem);
  }
}

type MappedResponsesCore = {
  input: ResponsesInputItem[];
  previousResponseId?: string;
  instructions?: string;
  /** 若展开过 compacted_window，则禁止叠 previous_response_id 续写 */
  usedCompactedWindow: boolean;
};

/**
 * stream / compact 共享的 input + instructions + opaque 续写映射。
 * compact 不附带 tools / stream 等生成字段。
 */
function mapResponsesCore(
  request: {
    input: InputItem[];
    instructions?: string | InstructionBlock[];
  },
  options?: { maxOpaquePayloadBytes?: number },
): MappedResponsesCore {
  const input: ResponsesInputItem[] = [];
  let previousResponseId: string | undefined;
  let usedCompactedWindow = false;
  let reasoningIndex = 0;

  for (const item of request.input) {
    switch (item.type) {
      case "message": {
        // EasyInputMessage：纯 text/json 仍发 string；含 image 时才升格为 input_* parts。
        // 切勿发送 { type: "text" } —— 官方 content part 是 input_text / output_text。
        input.push({
          type: "message",
          role: item.role,
          content: mapResponsesMessageContent(item.role, item.content, `input message (${item.role}) content`),
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
        const output = mapResponsesToolResultOutput(item.content, `tool_result ${item.callId} content`);
        input.push({
          type: "function_call_output",
          call_id: item.callId,
          output,
        });
        break;
      }
      case "opaque": {
        // Canonical replay 优先；compacted_window 原样展开；否则 previous_response_id 服务端续写。
        // 注意：response id 不能塞进 item_reference（那是 item id）；不叠 wire assistant。
        const payload = acceptOpaqueReplay(item, OPAQUE_SOURCE.RESPONSES, {
          maxBytes: options?.maxOpaquePayloadBytes,
        });
        if (!payload) break;

        // compacted_window：压缩结果整窗回传；与 previous_response_id 互斥（window 为准）
        if (payload.kind === RESPONSES_COMPACTED_WINDOW_KIND) {
          assertOptionalIdFields(payload);
          appendCompactedWindow(input, payload);
          usedCompactedWindow = true;
          // 有 window 时丢弃已收集的 previous_response_id，避免双上下文
          previousResponseId = undefined;
          break;
        }

        assertOptionalIdFields(payload);

        // 已有 compacted_window 后忽略 id 续写 opaque（window 已是完整上下文）
        if (usedCompactedWindow) break;

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

  const mapped: MappedResponsesCore = {
    input,
    usedCompactedWindow,
  };
  if (previousResponseId && !usedCompactedWindow) {
    mapped.previousResponseId = previousResponseId;
  }
  if (request.instructions) {
    mapped.instructions = mapper.mapInstructions(request.instructions);
  }
  return mapped;
}

/** 构建 Responses 流式请求体；调用方再 `withExtraBody` 合并构造期扩展字段。 */
export function buildResponsesRequest(
  request: NormalizedRequest,
  options?: { maxOpaquePayloadBytes?: number },
): ResponsesAPIRequest {
  const core = mapResponsesCore(request, options);

  const body: ResponsesAPIRequest = {
    model: request.model,
    input: core.input,
    stream: true,
  };

  if (core.previousResponseId) {
    body.previous_response_id = core.previousResponseId;
  }
  if (core.instructions) {
    body.instructions = core.instructions;
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

  body.tool_choice = mapper.mapToolChoice<Exclude<ResponsesAPIRequest["tool_choice"], undefined>>(request.toolChoice, {
    auto: "auto",
    none: "none",
    tool: (name) => ({ type: "function" as const, name }),
  });

  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
  if (request.metadata) body.metadata = request.metadata;
  if (request.reasoningLevel !== undefined) {
    body.reasoning = mapResponsesReasoning(request.reasoningLevel);
  }

  applyPromptCacheFields(body as Record<string, unknown>, request, "responses");
  return body;
}

/**
 * 构建 Responses compact 请求体（POST /responses/compact）。
 * 仅映射 model / input / instructions / previous_response_id；无 stream / tools。
 */
export function buildResponsesCompactRequest(
  request: CompressRequest,
  options?: { maxOpaquePayloadBytes?: number },
): ResponsesCompactAPIRequest {
  if (!request.model || typeof request.model !== "string" || request.model.length === 0) {
    throw new AIRequestError("compress requires a non-empty model", "INPUT_EMPTY");
  }
  if (!Array.isArray(request.input) || request.input.length === 0) {
    throw new AIRequestError("compress requires a non-empty input", "INPUT_EMPTY");
  }

  const core = mapResponsesCore(request, options);
  const body: ResponsesCompactAPIRequest = {
    model: request.model,
    input: core.input,
  };
  if (core.previousResponseId) {
    body.previous_response_id = core.previousResponseId;
  }
  if (core.instructions) {
    body.instructions = core.instructions;
  }
  return body;
}
