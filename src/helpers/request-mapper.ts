import { AIRequestError } from "../core/errors.js";
import { contentBlocksToText } from "./mapping.js";

import type { ContentBlock, InstructionBlock, ToolCallItem } from "../types/index.js";

export class NormalizedRequestMapper {
  constructor(readonly kind: string) {}

  mapInstructions(instructions: string | InstructionBlock[]): string {
    return typeof instructions === "string"
      ? instructions
      : contentBlocksToText(this.ensureTextBlocks(instructions, "instructions"));
  }

  ensureTextBlocks(blocks: ContentBlock[], field: string): ContentBlock[] {
    return this.ensureBlocks(blocks, field, ["text", "json"], "only text/json blocks are supported");
  }

  ensureReasoningBlocks(blocks: ContentBlock[], field: string): Array<Extract<ContentBlock, { type: "text" }>> {
    return this.ensureBlocks(blocks, field, ["text"], "reasoning only supports text blocks") as Array<
      Extract<ContentBlock, { type: "text" }>
    >;
  }

  parseToolArguments(item: ToolCallItem): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(item.argumentsText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // handled below
    }

    throw new AIRequestError(
      `${this.kind} requires tool_call argumentsText to be a valid JSON object`,
      "TOOL_CALL_ARGUMENTS_INVALID",
    );
  }

  rollbackTrailingAssistantMessages<T extends { role: string }>(messages: T[]): void {
    while (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
      messages.pop();
    }
  }

  private ensureBlocks(
    blocks: ContentBlock[],
    field: string,
    supportedTypes: ReadonlyArray<ContentBlock["type"]>,
    description: string,
  ): ContentBlock[] {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block && !supportedTypes.includes(block.type)) {
        throw new AIRequestError(
          `${this.kind} does not support ${field}[${i}] of type "${block.type}"; ${description}`,
          "UNSUPPORTED_CONTENT_BLOCK",
        );
      }
    }

    return blocks;
  }
}
