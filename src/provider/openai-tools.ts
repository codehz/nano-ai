/**
 * OpenAI 风格 function tool 声明映射（chat.completions / ollama 等同构）。
 */

import type { ToolDefinition } from "../types/index.js";

export type OpenAiFunctionTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export function mapOpenAiFunctionTool(tool: ToolDefinition): OpenAiFunctionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  };
}
