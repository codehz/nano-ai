/**
 * DeltaCompletionsAdapter — request 映射
 */

import { AIRequestError } from "../../runtime/errors.js";
import { acceptOpaqueReplay } from "../../provider/opaque-replay.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";
import { OPAQUE_SOURCE } from "../../provider/opaque-sources.js";

import type { NormalizedRequest } from "../../types/index.js";
import type { DeltaChatMessage, DeltaChatRequest } from "./types.js";

export const mapper = new NormalizedRequestMapper("delta-completions");

export function isDeltaReplayMessage(value: unknown): value is DeltaChatMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  const role = msg.role;
  return (role === "system" || role === "user" || role === "assistant") && typeof msg.content === "string";
}

export function assertDeltaReplayMessages(messages: unknown, field: string): asserts messages is DeltaChatMessage[] {
  if (!Array.isArray(messages)) {
    throw new AIRequestError(`Invalid opaque replay payload: ${field} must be an array`, "INVALID_OPAQUE_REPLAY");
  }
  for (let i = 0; i < messages.length; i++) {
    if (!isDeltaReplayMessage(messages[i])) {
      throw new AIRequestError(
        `Invalid opaque replay payload: ${field}[${i}] is not a valid delta-completions text message`,
        "INVALID_OPAQUE_REPLAY",
      );
    }
  }
}

function assertTextOnlyRequest(request: NormalizedRequest): void {
  mapper.assertNoServerTools(request.serverTools);
  if (request.tools && request.tools.length > 0) {
    throw new AIRequestError(
      "delta-completions does not support tools; use ChatCompletionsAdapter",
      "UNSUPPORTED_TOOL",
    );
  }
  if (request.toolChoice) {
    throw new AIRequestError(
      "delta-completions does not support toolChoice; use ChatCompletionsAdapter",
      "UNSUPPORTED_TOOL",
    );
  }
}

export function buildDeltaCompletionsRequest(
  request: NormalizedRequest,
  options?: { maxOpaquePayloadBytes?: number },
): DeltaChatRequest {
  assertTextOnlyRequest(request);

  const messages: DeltaChatMessage[] = [];

  if (request.instructions) {
    messages.push({ role: "system", content: mapper.mapInstructions(request.instructions) });
  }

  for (const item of request.input) {
    switch (item.type) {
      case "message": {
        messages.push({
          role: item.role,
          content: mapper.textFromBlocks(item.content, `input message (${item.role}) content`),
        });
        break;
      }
      case "reasoning": {
        messages.push({
          role: "assistant",
          content: mapper.textFromBlocks(item.content, "reasoning content"),
        });
        break;
      }
      case "opaque": {
        const payload = acceptOpaqueReplay(item, OPAQUE_SOURCE.DELTA_COMPLETIONS, {
          maxBytes: options?.maxOpaquePayloadBytes,
        });
        if (!payload) break;
        if ("messages" in payload) {
          assertDeltaReplayMessages(payload.messages, "messages");
          mapper.rollbackTrailingAssistantMessages(messages);
          for (const m of payload.messages) {
            messages.push({ role: m.role, content: m.content });
          }
        }
        break;
      }
      case "tool_call":
      case "tool_result":
      case "server_tool_call":
      case "server_tool_result":
      case "server_tool_discovery": {
        throw new AIRequestError(
          `delta-completions does not support input item type "${item.type}"; use ChatCompletionsAdapter`,
          "UNSUPPORTED_TOOL",
        );
      }
    }
  }

  const body: DeltaChatRequest = {
    model: request.model,
    messages,
    stream: true,
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
  return body;
}
