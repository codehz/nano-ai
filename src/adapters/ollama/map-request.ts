/**
 * OllamaAdapter — request 映射
 */

import { AIRequestError } from "../../runtime/errors.js";
import { contentBlocksToText } from "../../canonical/index.js";
import { acceptOpaqueReplay } from "../../provider/opaque-replay.js";
import { parseImageDataUrl } from "../../provider/image-url.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";
import { mapOllamaThink } from "../../provider/reasoning.js";
import { mapOpenAiFunctionTool } from "../../provider/openai-tools.js";
import { OPAQUE_SOURCE } from "../../provider/opaque-sources.js";

import type { ContentBlock, NormalizedRequest } from "../../types/index.js";
import type { OllamaChatRequest, OllamaMessage, OllamaToolCall } from "./types.js";

export const mapper = new NormalizedRequestMapper("ollama");

// ── Ollama 流式 chunk ─────────────────────────────────────────

export type OllamaChatChunk = {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  // 计时与用量（仅 final chunk 有值）
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
};

/** Opaque replay may carry optional local `id`s; wire tool_calls never include them. */
export type OllamaReplayToolCall = OllamaToolCall & { id?: string };

export function isOllamaReplayToolCalls(value: unknown): value is OllamaReplayToolCall[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (!entry || typeof entry !== "object" || !("function" in entry)) return false;
      const fn = (entry as { function?: unknown }).function;
      const id = (entry as { id?: unknown }).id;
      if (id !== undefined && typeof id !== "string") return false;
      return (
        !!fn &&
        typeof fn === "object" &&
        "name" in fn &&
        typeof (fn as { name?: unknown }).name === "string" &&
        "arguments" in fn &&
        typeof (fn as { arguments?: unknown }).arguments === "object" &&
        (fn as { arguments?: unknown }).arguments !== null
      );
    })
  );
}

export function toWireOllamaToolCalls(toolCalls: OllamaReplayToolCall[]): OllamaToolCall[] {
  return toolCalls.map((tc) => ({
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments,
    },
  }));
}

export function mapOllamaImageData(imageUrl: string, field: string): string {
  const dataUrl = parseImageDataUrl(imageUrl);
  if (!dataUrl) {
    throw new AIRequestError(
      `ollama cannot map ${field} imageUrl without fetching; only data:image/(jpeg|png|gif|webp);base64,... is supported`,
      "UNSUPPORTED_CONTENT_BLOCK",
    );
  }
  return dataUrl.data;
}

function mapOllamaUserMessage(blocks: ContentBlock[], field: string): Pick<OllamaMessage, "content" | "images"> {
  mapper.ensureBlocks(blocks, field, ["text", "json", "image"], "only text/json/image blocks are supported");
  const images: string[] = [];
  const textBlocks: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "image") {
      images.push(mapOllamaImageData(block.imageUrl, field));
      continue;
    }
    textBlocks.push(block);
  }

  return {
    content: contentBlocksToText(textBlocks),
    ...(images.length > 0 ? { images } : {}),
  };
}

function mapOllamaToolResultContent(blocks: ContentBlock[], field: string): Pick<OllamaMessage, "content" | "images"> {
  mapper.ensureBlocks(blocks, field, ["text", "json", "image"], "only text/json/image blocks are supported");
  const textBlocks: ContentBlock[] = [];
  const images: string[] = [];
  for (const block of blocks) {
    if (block.type === "image") {
      images.push(mapOllamaImageData(block.imageUrl, field));
    } else {
      textBlocks.push(block);
    }
  }
  return {
    content: contentBlocksToText(textBlocks),
    ...(images.length > 0 ? { images } : {}),
  };
}

export function buildOllamaRequest(
  request: NormalizedRequest,
  options?: { maxOpaquePayloadBytes?: number },
): OllamaChatRequest {
  mapper.assertNoServerTools(request.serverTools);

  const messages: OllamaMessage[] = [];
  /** Local-only name → call id queue for best-effort tool_result association (not sent to Ollama). */
  const callIdsByName = new Map<string, string[]>();

  // handle instructions → system message
  if (request.instructions) {
    messages.push({ role: "system", content: mapper.mapInstructions(request.instructions) });
  }

  for (const item of request.input) {
    switch (item.type) {
      case "message": {
        const field = `input message (${item.role}) content`;
        if (item.role === "user") {
          messages.push({
            role: "user",
            ...mapOllamaUserMessage(item.content, field),
          });
          break;
        }
        messages.push({
          role: item.role,
          content: mapper.textFromBlocks(item.content, field),
        });
        break;
      }
      case "tool_call": {
        // Ollama expects tool_calls on the last assistant message
        const lastAssistant = messages.findLast((m) => m.role === "assistant");
        const tc: OllamaToolCall = {
          function: {
            name: item.name,
            arguments: mapper.parseToolArguments(item),
          },
        };
        const queue = callIdsByName.get(item.name) ?? [];
        queue.push(item.id);
        callIdsByName.set(item.name, queue);
        if (lastAssistant) {
          lastAssistant.tool_calls = [...(lastAssistant.tool_calls ?? []), tc];
        } else {
          messages.push({ role: "assistant", content: "", tool_calls: [tc] });
        }
        break;
      }
      case "tool_result": {
        // Best-effort: consume matching id from name queue when present (no wire call_id)
        const queue = callIdsByName.get(item.toolName);
        if (queue && queue.length > 0) {
          queue.shift();
        }
        messages.push({
          role: "tool",
          ...mapOllamaToolResultContent(item.content, `tool_result ${item.callId} content`),
        });
        break;
      }
      case "reasoning": {
        // Ollama doesn't support reasoning in input; convert to text message
        messages.push({
          role: "assistant",
          content: contentBlocksToText(mapper.ensureReasoningBlocks(item.content, "reasoning content")),
        });
        break;
      }
      case "opaque": {
        // Best-effort restore from opaque replay (local ids stripped before wire)
        const payload = acceptOpaqueReplay(item, OPAQUE_SOURCE.OLLAMA, {
          maxBytes: options?.maxOpaquePayloadBytes,
        });
        if (!payload) break;
        if (payload.role === "assistant" && typeof payload.content === "string") {
          mapper.rollbackTrailingAssistantMessages(messages);
          let replayToolCalls: OllamaReplayToolCall[] | undefined;
          if ("tool_calls" in payload && payload.tool_calls !== undefined) {
            if (!isOllamaReplayToolCalls(payload.tool_calls)) {
              throw new AIRequestError(
                "Invalid opaque replay payload: tool_calls is not a valid ollama tool_calls array",
                "INVALID_OPAQUE_REPLAY",
              );
            }
            replayToolCalls = payload.tool_calls;
          }
          // Record name → id order for best-effort tool_result correlation (local only)
          if (replayToolCalls) {
            for (const tc of replayToolCalls) {
              if (tc.id) {
                const queue = callIdsByName.get(tc.function.name) ?? [];
                queue.push(tc.id);
                callIdsByName.set(tc.function.name, queue);
              }
            }
          }
          messages.push({
            role: "assistant",
            content: payload.content,
            tool_calls: replayToolCalls ? toWireOllamaToolCalls(replayToolCalls) : undefined,
          });
        }
        break;
      }
    }
  }

  const body: OllamaChatRequest = {
    model: request.model,
    messages,
    stream: true,
  };

  const toolChoice = request.toolChoice;
  const selectedTools =
    toolChoice === "none"
      ? []
      : toolChoice && typeof toolChoice === "object"
        ? request.tools?.filter((tool) => tool.name === toolChoice.name)
        : request.tools;

  if (selectedTools && selectedTools.length > 0) {
    body.tools = selectedTools.map(mapOpenAiFunctionTool);
  }

  if (request.temperature !== undefined || request.maxOutputTokens !== undefined) {
    body.options = {};
    if (request.temperature !== undefined) body.options.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) body.options.num_predict = request.maxOutputTokens;
  }

  if (request.reasoningLevel !== undefined) {
    body.think = mapOllamaThink(request.reasoningLevel);
  }

  return body;
}
