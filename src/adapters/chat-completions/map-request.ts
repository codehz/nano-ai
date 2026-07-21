/**
 * ChatCompletionsAdapter — request 映射
 */

import { AIRequestError } from "../../runtime/errors.js";
import { acceptOpaqueReplay } from "../../provider/opaque-replay.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";
import { mapChatCompletionsReasoningEffort } from "../../provider/reasoning.js";
import { mapOpenAiFunctionTool } from "../../provider/openai-tools.js";
import { OPAQUE_SOURCE } from "../../provider/opaque-sources.js";

import type { NormalizedRequest } from "../../types/index.js";
import {
  REASONING_FIELDS,
  type ChatRequest,
  type ChatMessage,
  type ChatToolCall,
  type ChatChunkChoice,
  type PendingToolCall,
  type ReasoningFieldName,
} from "./types.js";


export const mapper = new NormalizedRequestMapper("chat-completions");

export function extractReasoningText(value: unknown): string {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value.map(extractReasoningText).join("");
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "content", "reasoning", "reasoning_content", "thinking", "value"]) {
      const nested = extractReasoningText(record[key]);
      if (nested) return nested;
    }
  }

  return "";
}

export function extractReasoningDeltas(delta: ChatChunkChoice["delta"]): Array<{ field: ReasoningFieldName; text: string }> {
  const deltas: Array<{ field: ReasoningFieldName; text: string }> = [];

  for (const field of REASONING_FIELDS) {
    const text = extractReasoningText(delta[field]);
    if (text) {
      deltas.push({ field, text });
    }
  }

  return deltas;
}

export function isChatReplayToolCall(value: unknown): value is ChatToolCall {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.type !== "function") return false;
  const fn = entry.function;
  if (!fn || typeof fn !== "object") return false;
  const f = fn as Record<string, unknown>;
  return typeof f.name === "string" && typeof f.arguments === "string";
}

export function isChatReplayMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  const role = msg.role;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    return false;
  }
  if (!(msg.content === null || typeof msg.content === "string")) {
    return false;
  }
  if (msg.tool_calls !== undefined) {
    if (!Array.isArray(msg.tool_calls) || !msg.tool_calls.every(isChatReplayToolCall)) {
      return false;
    }
  }
  if (msg.tool_call_id !== undefined && typeof msg.tool_call_id !== "string") {
    return false;
  }
  if (msg.name !== undefined && typeof msg.name !== "string") {
    return false;
  }
  return true;
}

export function assertChatReplayMessages(messages: unknown, field: string): asserts messages is ChatMessage[] {
  if (!Array.isArray(messages)) {
    throw new AIRequestError(`Invalid opaque replay payload: ${field} must be an array`, "INVALID_OPAQUE_REPLAY");
  }
  for (let i = 0; i < messages.length; i++) {
    if (!isChatReplayMessage(messages[i])) {
      throw new AIRequestError(
        `Invalid opaque replay payload: ${field}[${i}] is not a valid chat message`,
        "INVALID_OPAQUE_REPLAY",
      );
    }
  }
}

export function buildAssistantReplayMessage(params: {
  content: string;
  reasoningByField: ReadonlyMap<ReasoningFieldName, string>;
  toolCalls: readonly PendingToolCall[];
}): ChatMessage | null {
  const { content, reasoningByField, toolCalls } = params;
  if (!content && reasoningByField.size === 0 && toolCalls.length === 0) return null;

  const replayMessage: ChatMessage = {
    role: "assistant",
    content: content || null,
  };

  for (const [field, text] of reasoningByField) {
    replayMessage[field] = text;
  }

  if (toolCalls.length > 0) {
    replayMessage.tool_calls = toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: toolCall.args,
      },
    }));
  }

  return replayMessage;
}


export function buildChatCompletionsRequest(request: NormalizedRequest): ChatRequest {
  mapper.assertNoServerTools(request.serverTools);

  const messages: ChatMessage[] = [];

  // handle instructions → system message
  if (request.instructions) {
    messages.push({ role: "system", content: mapper.mapInstructions(request.instructions) });
  }

  for (const item of request.input) {
    switch (item.type) {
      case "message": {
        const role = item.role;
        const text = mapper.textFromBlocks(item.content, `input message (${item.role}) content`);
        messages.push({ role, content: text || null });
        break;
      }
      case "tool_call": {
        // 只允许附着到尾部 assistant turn，否则新建一个
        const lastAssistant =
          messages.length > 0 && messages[messages.length - 1]?.role === "assistant"
            ? messages[messages.length - 1]
            : null;
        const tc: ChatToolCall = {
          id: item.id,
          type: "function",
          function: { name: item.name, arguments: item.argumentsText },
        };
        if (lastAssistant) {
          lastAssistant.tool_calls = [...(lastAssistant.tool_calls ?? []), tc];
        } else {
          messages.push({ role: "assistant", content: null, tool_calls: [tc] });
        }
        break;
      }
      case "tool_result": {
        messages.push({
          role: "tool",
          tool_call_id: item.callId,
          name: item.toolName,
          content: mapper.textFromBlocks(item.content, `tool_result ${item.callId} content`),
        });
        break;
      }
      case "reasoning": {
        // chat.completions doesn't support reasoning items in input
        // Convert to a text message for best-effort
        messages.push({
          role: "assistant",
          content: mapper.textFromBlocks(item.content, "reasoning content"),
        });
        break;
      }
      case "opaque": {
        const payload = acceptOpaqueReplay(item, OPAQUE_SOURCE.CHAT_COMPLETIONS);
        if (!payload) break;
        // 仅接受 messages 形；单条 role/content 已 deprecate（有效 envelope 下未识别 shape 跳过）
        if ("messages" in payload) {
          assertChatReplayMessages(payload.messages, "messages");
          mapper.rollbackTrailingAssistantMessages(messages);
          for (const m of payload.messages) {
            messages.push(m);
          }
        }
        break;
      }
    }
  }

  const body: ChatRequest = {
    model: request.model,
    messages,
    stream: true,
    n: 1,
  };

  body.tools = mapper.mapToolsIfPresent(request.tools, mapOpenAiFunctionTool);

  body.tool_choice = mapper.mapToolChoice<Exclude<ChatRequest["tool_choice"], undefined>>(request.toolChoice, {
    auto: "auto",
    none: "none",
    tool: (name) => ({ type: "function" as const, function: { name } }),
  });

  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
  if (request.metadata) body.metadata = request.metadata;
  if (request.reasoningLevel !== undefined) {
    body.reasoning_effort = mapChatCompletionsReasoningEffort(request.reasoningLevel);
  }

  return body;
}
