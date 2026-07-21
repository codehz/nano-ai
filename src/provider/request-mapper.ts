import { AIRequestError } from "../runtime/errors.js";
import { contentBlocksToText } from "../canonical/index.js";
import { parseJsonStrictObject } from "./json-parse.js";

import type {
  ContentBlock,
  InstructionBlock,
  ServerToolDefinition,
  ToolCallItem,
  ToolChoice,
  ToolDefinition,
} from "../types/index.js";

export class NormalizedRequestMapper {
  constructor(readonly kind: string) {}

  mapInstructions(instructions: string | InstructionBlock[]): string {
    return typeof instructions === "string"
      ? instructions
      : contentBlocksToText(this.ensureTextBlocks(instructions, "instructions"));
  }

  /** 不支持 serverTools 的 adapter 在 buildRequest 入口调用。 */
  assertNoServerTools(serverTools: ServerToolDefinition[] | undefined): void {
    if (serverTools && serverTools.length > 0) {
      throw new AIRequestError(
        `${this.kind} does not support serverTools; use ResponsesAdapter for web_search, code_execution, and mcp`,
        "UNSUPPORTED_SERVER_TOOL",
      );
    }
  }

  ensureTextBlocks(blocks: ContentBlock[], field: string): ContentBlock[] {
    return this.ensureBlocks(blocks, field, ["text", "json"], "only text/json blocks are supported");
  }

  ensureReasoningBlocks(blocks: ContentBlock[], field: string): Array<Extract<ContentBlock, { type: "text" }>> {
    return this.ensureBlocks(blocks, field, ["text"], "reasoning only supports text blocks") as Array<
      Extract<ContentBlock, { type: "text" }>
    >;
  }

  /** ensureTextBlocks + contentBlocksToText 的常见组合。 */
  textFromBlocks(blocks: ContentBlock[], field: string): string {
    return contentBlocksToText(this.ensureTextBlocks(blocks, field));
  }

  parseToolArguments(item: ToolCallItem): Record<string, unknown> {
    return parseJsonStrictObject(
      item.argumentsText,
      `${this.kind} requires tool_call argumentsText to be a valid JSON object`,
      "TOOL_CALL_ARGUMENTS_INVALID",
    );
  }

  /**
   * 回滚 wire 尾部连续同 role 的 turn（opaque replace 语义）。
   * chat/messages/ollama 用 `"assistant"`；gemini 用 `"model"`。
   */
  rollbackTrailingAssistantMessages<T extends { role: string }>(messages: T[], role = "assistant"): void {
    while (messages.length > 0 && messages[messages.length - 1]?.role === role) {
      messages.pop();
    }
  }

  mapToolsIfPresent<T>(tools: ToolDefinition[] | undefined, map: (tool: ToolDefinition) => T): T[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map(map);
  }

  /**
   * 将 canonical toolChoice 映射为 provider 形状。
   * 返回 undefined 表示调用方无需写入 body 字段。
   */
  mapToolChoice<T>(
    toolChoice: ToolChoice | undefined,
    mappers: {
      auto: T;
      none: T;
      tool: (name: string) => T;
    },
  ): T | undefined {
    if (!toolChoice) return undefined;
    if (toolChoice === "auto") return mappers.auto;
    if (toolChoice === "none") return mappers.none;
    if (toolChoice.type === "tool") return mappers.tool(toolChoice.name);
    return undefined;
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
