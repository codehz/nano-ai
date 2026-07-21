/**
 * 示例：服务端工具（Mock 脚本化）
 *
 * 展示：
 * 1. 请求携带 serverTools（与客户端 tools 独立）
 * 2. Mock 产出 server_tool_call / result / discovery 与 message.citations
 * 3. collectStream 聚合 serverToolCalls / serverToolResults
 *
 * 运行：bun run example:server-tools
 */

import { MockAdapter, assertMockRequest, collectStream, createAIClient, jsonBlock, textBlock } from "../src/index.js";

const adapter = new MockAdapter({
  handler: async function* (request, context) {
    assertMockRequest(
      request,
      {
        serverTools: "present",
        items: [{ type: "message", role: "user", textIncludes: "weather" }],
      },
      context,
    );

    yield {
      type: "server_tool_call",
      id: "st-search-1",
      tool: "web_search",
      name: "search",
      argumentsText: '{"query":"Hangzhou weather"}',
      streamArguments: false,
    };
    yield {
      type: "server_tool_result",
      item: {
        type: "server_tool_result",
        callId: "st-search-1",
        tool: "web_search",
        outcome: "success",
        content: [jsonBlock({ hits: 1, summary: "sunny" })],
      },
    };
    yield {
      type: "server_tool_discovery",
      item: {
        type: "server_tool_discovery",
        id: "disc-1",
        tool: "mcp",
        serverLabel: "dmcp",
        tools: [{ name: "roll", description: "Roll dice" }],
      },
    };
    yield {
      type: "message",
      content: "Hangzhou is sunny today.",
      citations: [{ type: "url", url: "https://example.com/weather", title: "Weather" }],
    };
  },
});

const client = createAIClient({
  adapter,
  model: "mock-model",
});

async function main() {
  const result = await collectStream(
    client.stream({
      input: [
        {
          type: "message",
          role: "user",
          content: [textBlock("What's the weather in Hangzhou?")],
        },
      ],
      serverTools: [{ type: "web_search" }],
    }),
  );

  console.log("stopReason:", result.stopReason);
  console.log("text:", result.text);
  console.log("serverToolCalls:", JSON.stringify(result.serverToolCalls, null, 2));
  console.log("serverToolResults:", JSON.stringify(result.serverToolResults, null, 2));
  console.log(
    "output types:",
    result.output.map((item) => item.type),
  );
  const message = result.output.find((item) => item.type === "message");
  console.log("citations:", message && message.type === "message" ? message.citations : undefined);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
