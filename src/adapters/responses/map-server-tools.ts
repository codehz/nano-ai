/**
 * canonical serverTools → Responses API tools 映射
 */

import { AIRequestError } from "../../runtime/errors.js";
import type { ServerToolDefinition } from "../../types/index.js";
import type {
  ResponsesCodeInterpreterTool,
  ResponsesMcpTool,
  ResponsesTool,
  ResponsesWebSearchTool,
} from "./types.js";

/** 将 canonical serverTools 映射为 Responses API tools 数组项。 */
export function mapServerTools(serverTools: ServerToolDefinition[] | undefined): ResponsesTool[] {
  if (!serverTools || serverTools.length === 0) return [];

  return serverTools.map((tool): ResponsesTool => {
    switch (tool.type) {
      case "web_search": {
        const mapped: ResponsesWebSearchTool = { type: "web_search" };
        if (tool.allowedDomains || tool.blockedDomains) {
          mapped.filters = {
            ...(tool.allowedDomains ? { allowed_domains: tool.allowedDomains } : {}),
            ...(tool.blockedDomains ? { blocked_domains: tool.blockedDomains } : {}),
          };
        }
        if (tool.userLocation) {
          mapped.user_location = {
            type: "approximate",
            ...(tool.userLocation.country !== undefined ? { country: tool.userLocation.country } : {}),
            ...(tool.userLocation.city !== undefined ? { city: tool.userLocation.city } : {}),
            ...(tool.userLocation.region !== undefined ? { region: tool.userLocation.region } : {}),
            ...(tool.userLocation.timezone !== undefined ? { timezone: tool.userLocation.timezone } : {}),
          };
        }
        if (tool.searchContextSize !== undefined) {
          mapped.search_context_size = tool.searchContextSize;
        }
        return mapped;
      }
      case "code_execution": {
        const container = tool.container;
        const mapped: ResponsesCodeInterpreterTool = {
          type: "code_interpreter",
          container: container
            ? {
                type: "auto",
                ...(container.memoryLimit !== undefined ? { memory_limit: container.memoryLimit } : {}),
                ...(container.fileIds !== undefined ? { file_ids: container.fileIds } : {}),
              }
            : { type: "auto" },
        };
        return mapped;
      }
      case "mcp": {
        const mapped: ResponsesMcpTool = {
          type: "mcp",
          server_label: tool.serverLabel,
          server_url: tool.serverUrl,
          require_approval: "never",
        };
        if (tool.serverDescription !== undefined) mapped.server_description = tool.serverDescription;
        if (tool.authorization !== undefined) mapped.authorization = tool.authorization;
        if (tool.allowedTools !== undefined) mapped.allowed_tools = tool.allowedTools;
        return mapped;
      }
      default: {
        const exhaustive: never = tool;
        throw new AIRequestError(
          `Unsupported server tool type: ${(exhaustive as ServerToolDefinition).type}`,
          "UNSUPPORTED_SERVER_TOOL",
        );
      }
    }
  });
}
