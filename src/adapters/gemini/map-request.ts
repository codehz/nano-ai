/**
 * GeminiAdapter — request 映射
 */

import { AIRequestError } from "../../runtime/errors.js";
import { contentBlocksToText } from "../../canonical/index.js";
import { acceptOpaqueReplay } from "../../provider/opaque-replay.js";
import { NormalizedRequestMapper } from "../../provider/request-mapper.js";
import { mapGeminiThinking } from "../../provider/reasoning.js";
import { OPAQUE_SOURCE } from "../../provider/opaque-sources.js";

import type { NormalizedRequest, ContentBlock } from "../../types/index.js";
import type {
  GeminiPart,
  GeminiContent,
  GeminiTool,
  GeminiFunctionCallingConfig,
  GeminiGenerateContentRequest,
} from "./types.js";


export const mapper = new NormalizedRequestMapper("gemini");

export function normalizeModelPath(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

export function isGeminiPart(value: unknown): value is GeminiPart {
  return !!value && typeof value === "object";
}

export function isGeminiContent(value: unknown): value is GeminiContent {
  if (!value || typeof value !== "object") return false;
  const content = value as Record<string, unknown>;
  if (content.role !== "user" && content.role !== "model") return false;
  if (!Array.isArray(content.parts)) return false;
  return content.parts.every(isGeminiPart);
}

export function assertGeminiReplayContent(content: unknown, field: string): asserts content is GeminiContent {
  if (!isGeminiContent(content)) {
    throw new AIRequestError(
      `Invalid opaque replay payload: ${field} is not a valid Gemini content object`,
      "INVALID_OPAQUE_REPLAY",
    );
  }
}

export function appendPart(contents: GeminiContent[], role: "user" | "model", part: GeminiPart): void {
  const last = contents[contents.length - 1];
  if (last && last.role === role) {
    last.parts.push(part);
    return;
  }
  contents.push({ role, parts: [part] });
}

export function textPartsFromBlocks(blocks: ContentBlock[], field: string): GeminiPart[] {
  const supported = mapper.ensureTextBlocks(blocks, field);
  return supported.map((block) => {
    if (block.type === "text") return { text: block.text };
    if (block.type === "json") return { text: JSON.stringify(block.json) };
    throw new AIRequestError(
      `gemini does not support content block type "${block.type}" in ${field}`,
      "UNSUPPORTED_CONTENT_BLOCK",
    );
  });
}

export function clonePart(part: GeminiPart): GeminiPart {
  return { ...part };
}

export function cloneContent(content: GeminiContent): GeminiContent {
  return {
    role: content.role,
    parts: content.parts.map(clonePart),
  };
}

export function mergeModelParts(base: GeminiPart[], incoming: GeminiPart[]): GeminiPart[] {
  const result = base.map(clonePart);
  for (const part of incoming) {
    const last = result[result.length - 1];
    const sameTextBucket =
      last &&
      typeof last.text === "string" &&
      typeof part.text === "string" &&
      !!last.thought === !!part.thought &&
      !last.functionCall &&
      !part.functionCall &&
      !last.functionResponse &&
      !part.functionResponse;

    if (sameTextBucket) {
      last.text = `${last.text ?? ""}${part.text ?? ""}`;
      if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature;
      continue;
    }

    result.push(clonePart(part));
  }
  return result;
}


export function buildGeminiRequest(request: NormalizedRequest): GeminiGenerateContentRequest {
  mapper.assertNoServerTools(request.serverTools);

  const contents: GeminiContent[] = [];
  let systemInstruction: GeminiGenerateContentRequest["systemInstruction"];

  if (request.instructions) {
    systemInstruction = {
      parts: [{ text: mapper.mapInstructions(request.instructions) }],
    };
  }

  for (const item of request.input) {
    switch (item.type) {
      case "message": {
        const role = item.role === "assistant" ? "model" : "user";
        for (const part of textPartsFromBlocks(item.content, `input message (${item.role}) content`)) {
          appendPart(contents, role, part);
        }
        break;
      }
      case "tool_call": {
        const part: GeminiPart = {
          functionCall: {
            id: item.id,
            name: item.name,
            args: mapper.parseToolArguments(item),
          },
        };
        appendPart(contents, "model", part);
        break;
      }
      case "tool_result": {
        let response: Record<string, unknown>;
        try {
          const text = mapper.textFromBlocks(item.content, `tool_result ${item.callId} content`);
          const parsed: unknown = text ? JSON.parse(text) : {};
          response =
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : { result: text };
        } catch {
          response = {
            result: mapper.textFromBlocks(item.content, `tool_result ${item.callId} content`),
          };
        }

        appendPart(contents, "user", {
          functionResponse: {
            id: item.callId,
            name: item.toolName,
            response,
          },
        });
        break;
      }
      case "reasoning": {
        const text = contentBlocksToText(mapper.ensureReasoningBlocks(item.content, "reasoning content"));
        appendPart(contents, "model", { text, thought: true });
        break;
      }
      case "opaque": {
        const payload = acceptOpaqueReplay(item, OPAQUE_SOURCE.GEMINI);
        if (!payload) break;
        if (payload.replaceCanonical === true && "content" in payload) {
          assertGeminiReplayContent(payload.content, "content");
          mapper.rollbackTrailingAssistantMessages(contents, "model");
          contents.push(cloneContent(payload.content));
        } else if (isGeminiContent(payload)) {
          mapper.rollbackTrailingAssistantMessages(contents, "model");
          contents.push(cloneContent(payload));
        }
        break;
      }
    }
  }

  const body: GeminiGenerateContentRequest = {
    contents,
  };

  if (systemInstruction) body.systemInstruction = systemInstruction;

  body.tools = mapper.mapToolsIfPresent(
    request.tools,
    (tool): GeminiTool => ({
      functionDeclarations: [
        {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      ],
    }),
  );

  // Gemini tools 通常合并为一个 tool 对象下的 declarations
  if (body.tools && body.tools.length > 1) {
    body.tools = [
      {
        functionDeclarations: body.tools.flatMap((tool) => tool.functionDeclarations),
      },
    ];
  }

  const functionCallingConfig = mapper.mapToolChoice<GeminiFunctionCallingConfig>(request.toolChoice, {
    auto: { mode: "AUTO" },
    none: { mode: "NONE" },
    tool: (name) => ({ mode: "ANY", allowedFunctionNames: [name] }),
  });
  if (functionCallingConfig) {
    body.toolConfig = { functionCallingConfig };
  }

  const generationConfig: NonNullable<GeminiGenerateContentRequest["generationConfig"]> = {};
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  if (request.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = request.maxOutputTokens;
  if (request.reasoningLevel !== undefined) {
    generationConfig.thinkingConfig = mapGeminiThinking(request.reasoningLevel);
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }

  return body;
}
