/**
 * Responses 纯映射单测（深路径导入，不经公开 API）
 */

import { describe, it, expect } from "bun:test";
import { AIRequestError } from "../../src/index.js";
import { mapServerTools } from "../../src/adapters/responses/map-server-tools.js";
import { inferResponsesStopReason } from "../../src/adapters/responses/infer-stop-reason.js";
import {
  KNOWN_RESPONSES_SSE_TYPES,
  mapWebSearchCallItem,
  mapCodeInterpreterCallItem,
  mapMcpCallItem,
  mapMcpListToolsItem,
} from "../../src/adapters/responses/map-items.js";
import type { ServerToolDefinition } from "../../src/index.js";
import type { ResponsesAPIResponse } from "../../src/adapters/responses/types.js";

describe("mapServerTools", () => {
  it("maps web_search filters, location and context size", () => {
    const tools = mapServerTools([
      {
        type: "web_search",
        allowedDomains: ["example.com"],
        blockedDomains: ["bad.example"],
        userLocation: { type: "approximate", country: "CN", city: "Hangzhou" },
        searchContextSize: "low",
      },
    ]);

    expect(tools).toEqual([
      {
        type: "web_search",
        filters: {
          allowed_domains: ["example.com"],
          blocked_domains: ["bad.example"],
        },
        user_location: { type: "approximate", country: "CN", city: "Hangzhou" },
        search_context_size: "low",
      },
    ]);
  });

  it("maps code_execution container and defaults to auto", () => {
    expect(
      mapServerTools([
        {
          type: "code_execution",
          container: { type: "auto", memoryLimit: "4g", fileIds: ["file-1"] },
        },
      ]),
    ).toEqual([
      {
        type: "code_interpreter",
        container: { type: "auto", memory_limit: "4g", file_ids: ["file-1"] },
      },
    ]);

    expect(mapServerTools([{ type: "code_execution" }])).toEqual([
      { type: "code_interpreter", container: { type: "auto" } },
    ]);
  });

  it("maps mcp fields with require_approval never", () => {
    expect(
      mapServerTools([
        {
          type: "mcp",
          serverLabel: "dmcp",
          serverUrl: "https://dmcp-server.example/mcp",
          serverDescription: "dice",
          authorization: "secret-token",
          allowedTools: ["roll"],
          requireApproval: "never",
        },
      ]),
    ).toEqual([
      {
        type: "mcp",
        server_label: "dmcp",
        server_url: "https://dmcp-server.example/mcp",
        server_description: "dice",
        authorization: "secret-token",
        allowed_tools: ["roll"],
        require_approval: "never",
      },
    ]);
  });

  it("returns empty array for missing serverTools", () => {
    expect(mapServerTools(undefined)).toEqual([]);
    expect(mapServerTools([])).toEqual([]);
  });

  it("throws UNSUPPORTED_SERVER_TOOL for unknown type", () => {
    expect(() =>
      mapServerTools([{ type: "not_a_tool" } as unknown as ServerToolDefinition]),
    ).toThrow(AIRequestError);

    try {
      mapServerTools([{ type: "not_a_tool" } as unknown as ServerToolDefinition]);
    } catch (error) {
      expect(error).toBeInstanceOf(AIRequestError);
      expect((error as AIRequestError).code).toBe("UNSUPPORTED_SERVER_TOOL");
    }
  });
});

function responsesApiResponse(overrides: Partial<ResponsesAPIResponse> = {}): ResponsesAPIResponse {
  return {
    id: "resp-1",
    model: "gpt-4o",
    output: [],
    ...overrides,
  };
}

describe("inferResponsesStopReason", () => {
  it("maps completed message output to end_turn", () => {
    expect(
      inferResponsesStopReason(
        responsesApiResponse({
          status: "completed",
          output: [{ id: "m1", type: "message", status: "completed" }],
        }),
      ),
    ).toBe("end_turn");
  });

  it("maps function_call presence to tool_call", () => {
    expect(
      inferResponsesStopReason(
        responsesApiResponse({
          status: "completed",
          output: [
            { id: "m1", type: "message" },
            { id: "fc1", type: "function_call", name: "get_weather", call_id: "call_1" },
          ],
        }),
      ),
    ).toBe("tool_call");
  });

  it("maps failed status to error", () => {
    expect(inferResponsesStopReason(responsesApiResponse({ status: "failed" }))).toBe("error");
  });

  it("maps incomplete content_filter and max_output_tokens", () => {
    expect(
      inferResponsesStopReason(
        responsesApiResponse({
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        }),
      ),
    ).toBe("content_filter");

    expect(
      inferResponsesStopReason(
        responsesApiResponse({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      ),
    ).toBe("max_output_tokens");

    expect(inferResponsesStopReason(responsesApiResponse({ status: "incomplete" }))).toBe(
      "max_output_tokens",
    );
  });

  it("maps empty output by status", () => {
    expect(inferResponsesStopReason(responsesApiResponse({ status: "completed", output: [] }))).toBe(
      "end_turn",
    );
    expect(
      inferResponsesStopReason(responsesApiResponse({ status: "in_progress", output: [] })),
    ).toBe("unknown");
  });

  it("maps last item failed/incomplete status", () => {
    expect(
      inferResponsesStopReason(
        responsesApiResponse({
          status: "completed",
          output: [{ id: "m1", type: "message", status: "failed" }],
        }),
      ),
    ).toBe("error");

    expect(
      inferResponsesStopReason(
        responsesApiResponse({
          status: "completed",
          output: [{ id: "m1", type: "message", status: "incomplete" }],
        }),
      ),
    ).toBe("max_output_tokens");
  });
});

describe("KNOWN_RESPONSES_SSE_TYPES", () => {
  it("includes critical stream event types", () => {
    for (const type of [
      "response.output_text.delta",
      "response.completed",
      "response.function_call_arguments.delta",
      "response.reasoning_summary_text.delta",
      "response.web_search_call.completed",
      "response.code_interpreter_call_code.delta",
      "response.mcp_call.completed",
      "error",
    ]) {
      expect(KNOWN_RESPONSES_SSE_TYPES.has(type)).toBe(true);
    }
  });

  it("does not include fabricated event types", () => {
    expect(KNOWN_RESPONSES_SSE_TYPES.has("response.totally_unknown.event")).toBe(false);
  });
});

describe("server tool item mappers", () => {
  it("maps web_search_call with sources result", () => {
    const { call, result } = mapWebSearchCallItem({
      id: "ws_1",
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        query: "nano-ai",
        sources: [{ url: "https://example.com" }],
      },
    });

    expect(call.id).toBe("ws_1");
    expect(call.tool).toBe("web_search");
    expect(call.name).toBe("search");
    expect(call.argumentsText).toBe(JSON.stringify({ query: "nano-ai" }));
    expect(call.status).toBe("completed");
    expect(result?.callId).toBe("ws_1");
    expect(result?.outcome).toBe("success");
    expect(result?.content[0]).toEqual({ type: "json", json: { sources: [{ url: "https://example.com" }] } });
  });

  it("maps code_interpreter_call code and log outputs", () => {
    const { call, result } = mapCodeInterpreterCallItem({
      id: "ci_1",
      type: "code_interpreter_call",
      status: "completed",
      code: "print(1)",
      container_id: "ctr_1",
      outputs: [{ type: "logs", logs: "1\n" }],
    });

    expect(call.tool).toBe("code_execution");
    expect(call.name).toBe("python");
    expect(call.argumentsText).toBe("print(1)");
    expect(call.providerPayload).toEqual({ containerId: "ctr_1", status: "completed" });
    expect(result?.content).toEqual([{ type: "text", text: "1\n" }]);
  });

  it("maps mcp_call success and failure", () => {
    const ok = mapMcpCallItem({
      id: "mcp_1",
      type: "mcp_call",
      name: "roll",
      arguments: '{"sides":6}',
      server_label: "dmcp",
      output: "4",
    });
    expect(ok.call.tool).toBe("mcp");
    expect(ok.call.status).toBe("completed");
    expect(ok.result.outcome).toBe("success");
    expect(ok.result.content).toEqual([{ type: "text", text: "4" }]);

    const failed = mapMcpCallItem({
      id: "mcp_2",
      type: "mcp_call",
      name: "roll",
      server_label: "dmcp",
      error: "timeout",
    });
    expect(failed.call.status).toBe("failed");
    expect(failed.result.outcome).toBe("error");
    expect(failed.result.content.some((b) => b.type === "text" && b.text === "timeout")).toBe(true);
  });

  it("maps mcp_list_tools discovery", () => {
    const discovery = mapMcpListToolsItem({
      id: "list_1",
      type: "mcp_list_tools",
      server_label: "dmcp",
      tools: [
        { name: "roll", description: "Roll a die", input_schema: { type: "object" } },
        { name: 123 },
      ],
    });

    expect(discovery.id).toBe("list_1");
    expect(discovery.serverLabel).toBe("dmcp");
    expect(discovery.tools).toEqual([
      { name: "roll", description: "Roll a die", inputSchema: { type: "object" } },
    ]);
  });
});
