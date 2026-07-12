import { AIRequestError } from "../core/errors.js";
import { contentBlocksToText } from "./mapping.js";

import type { AdapterCapabilities, ContentBlock, InstructionBlock, ToolResultItem } from "../types/index.js";

export type ProviderProfile = {
  readonly kind: string;
  readonly instructionsMode: "system_message" | "instructions_field" | "none";
  readonly supportedBlockTypes: ReadonlyArray<ContentBlock["type"]>;
  readonly reasoningBlockTypes: ReadonlyArray<ContentBlock["type"]>;
  readonly capabilities: AdapterCapabilities;
};

export class NormalizedRequestMapper {
  constructor(readonly profile: ProviderProfile) {}

  mapInstructions(instructions: string | InstructionBlock[]): string {
    return typeof instructions === "string"
      ? instructions
      : contentBlocksToText(this.ensureTextBlocks(instructions, "instructions"));
  }

  ensureTextBlocks(blocks: ContentBlock[], field: string): ContentBlock[] {
    return this.ensureBlocks(blocks, field, this.profile.supportedBlockTypes, "only text/json blocks are supported");
  }

  ensureReasoningBlocks(blocks: ContentBlock[], field: string): Array<Extract<ContentBlock, { type: "text" }>> {
    return this.ensureBlocks(
      blocks,
      field,
      this.profile.reasoningBlockTypes,
      "reasoning only supports text blocks",
    ) as Array<Extract<ContentBlock, { type: "text" }>>;
  }

  assertToolResultOutcome(outcome: ToolResultItem["outcome"]): void {
    if (this.profile.capabilities.toolResultOutcomes.includes(outcome)) return;

    const outcomes = this.profile.capabilities.toolResultOutcomes;
    const supported = outcomes.map((value) => `"${value}"`).join(" and ");
    const verb = outcomes.length > 1 ? "are" : "is";
    throw new AIRequestError(
      `${this.profile.kind} does not preserve tool_result outcome "${outcome}"; only ${supported} ${verb} supported`,
      "UNSUPPORTED_TOOL_RESULT_OUTCOME",
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
          `${this.profile.kind} does not support ${field}[${i}] of type "${block.type}"; ${description}`,
          "UNSUPPORTED_CONTENT_BLOCK",
        );
      }
    }

    return blocks;
  }
}
