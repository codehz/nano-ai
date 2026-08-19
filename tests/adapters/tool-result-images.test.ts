/**
 * Client tool_result image mapping regression tests.
 */

import { describe, expect, it } from "bun:test";

import { normalizeRequest } from "../../src/runtime/normalize.js";
import { buildChatCompletionsRequest } from "../../src/adapters/chat-completions/map-request.js";
import { buildGeminiRequest } from "../../src/adapters/gemini/map-request.js";
import { buildMessagesRequest } from "../../src/adapters/messages/map-request.js";
import { buildOllamaRequest } from "../../src/adapters/ollama/map-request.js";
import { buildResponsesRequest } from "../../src/adapters/responses/map-request.js";
import type { AIRequest, ToolResultItem } from "../../src/types/index.js";

const remoteImage = "https://example.com/cat.png";
const dataImage = "data:image/png;base64,aGVsbG8=";

function toolResult(content: ToolResultItem["content"]): ToolResultItem {
  return {
    type: "tool_result",
    callId: "call-1",
    toolName: "inspect",
    outcome: "success",
    content,
  };
}

function request(input: ToolResultItem): ReturnType<typeof normalizeRequest> {
  const aiRequest: AIRequest = { input: [input] };
  return normalizeRequest(aiRequest, { model: "test-model" });
}

describe("client tool_result image mapping", () => {
  it("maps image parts in Chat Completions tool content", () => {
    const body = buildChatCompletionsRequest(
      request(
        toolResult([
          { type: "text", text: "cat" },
          { type: "image", imageUrl: remoteImage },
        ]),
      ),
    );

    expect(body.messages).toEqual([
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "inspect",
        content: [
          { type: "text", text: "cat" },
          { type: "image_url", image_url: { url: remoteImage } },
        ],
      },
    ]);
  });

  it("maps image blocks into an Anthropic tool_result content array", () => {
    const body = buildMessagesRequest(
      request(
        toolResult([
          { type: "text", text: "cat" },
          { type: "image", imageUrl: remoteImage },
        ]),
      ),
    );

    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: [
              { type: "text", text: "cat" },
              { type: "image", source: { type: "url", url: remoteImage } },
            ],
            is_error: false,
          },
        ],
      },
    ]);
  });

  it("maps Gemini tool response text and inline image parts", () => {
    const body = buildGeminiRequest(
      request(
        toolResult([
          { type: "json", json: { label: "cat" } },
          { type: "image", imageUrl: dataImage },
        ]),
      ),
    );

    expect(body.contents).toEqual([
      {
        role: "user",
        parts: [
          {
            functionResponse: { id: "call-1", name: "inspect", response: { label: "cat" } },
          },
          { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
        ],
      },
    ]);
  });

  it("maps data-URL images into Ollama tool messages", () => {
    const body = buildOllamaRequest(
      request(
        toolResult([
          { type: "text", text: "cat" },
          { type: "image", imageUrl: dataImage },
        ]),
      ),
    );

    expect(body.messages).toEqual([
      {
        role: "tool",
        content: "cat",
        images: ["aGVsbG8="],
      },
    ]);
  });

  it("maps Responses function output with image content parts", () => {
    const body = buildResponsesRequest(
      request(
        toolResult([
          { type: "text", text: "cat" },
          { type: "image", imageUrl: remoteImage },
        ]),
      ),
    );

    expect(body.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call-1",
        output: [
          { type: "input_text", text: "cat" },
          { type: "input_image", image_url: remoteImage },
        ],
      },
    ]);
  });
});
