/**
 * 示例 3：手动工具循环
 *
 * 展示库的推荐工具调用模式：
 * 1. 模型返回 tool_call
 * 2. 调用方执行工具
 * 3. 调用方将 tool_result 放入下一轮 input
 * 4. 再次调用 client.stream()
 *
 * 该示例使用 MockAdapter，直接演示 tools / toolChoice / replay / tool_result 接口。
 */

import { MockAdapter, assertMockRequest, collectStream, createAIClient, jsonBlock, textBlock } from "../src/index.js";

import type { InputItem, ToolCallItem } from "../src/index.js";

const adapter = new MockAdapter({
  handler: async function* (request, context) {
    if (context.turnIndex === 0) {
      assertMockRequest(
        request,
        {
          ordered: true,
          items: [{ type: "message", role: "user", textIncludes: "weather in Hangzhou" }],
          tools: "present",
          toolChoice: "present",
        },
        context,
      );

      yield { type: "message", content: "Checking live weather now." };
      yield {
        type: "tool_call",
        id: "call-weather-1",
        name: "get_weather",
        argumentsText: '{"city":"Hangzhou"}',
      };
      return;
    }

    assertMockRequest(
      request,
      {
        ordered: true,
        requireReplayFromPreviousTurn: true,
        requireToolResultsForPendingCalls: true,
        items: [
          { type: "message", role: "assistant", textIncludes: "Checking live weather now." },
          { type: "tool_call", name: "get_weather", textIncludes: "Hangzhou" },
          {
            type: "tool_result",
            callId: "call-weather-1",
            toolName: "get_weather",
            outcome: "success",
            textIncludes: "sunny",
          },
        ],
      },
      context,
    );

    yield { type: "message", content: "Hangzhou is 28C and sunny." };
    yield {
      type: "complete",
      usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
      providerMetadata: { scenario: "tool-loop-example" },
    };
  },
});

const client = createAIClient({
  adapter,
  model: "mock-model",
});

async function runTool(call: ToolCallItem): Promise<unknown> {
  console.log(`  → Executing ${call.name}(${call.argumentsText})`);

  switch (call.name) {
    case "get_weather": {
      const args = JSON.parse(call.argumentsText) as { city?: string };
      return { temperature: 28, condition: "sunny", city: args.city ?? "unknown" };
    }
    case "search_web": {
      return { results: [`Result for ${call.argumentsText}`] };
    }
    default:
      return { error: `Unknown tool: ${call.name}` };
  }
}

const tools = [
  {
    name: "get_weather",
    description: "Get current weather for a city",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
      },
      required: ["city"],
    },
  },
  {
    name: "search_web",
    description: "Search the web for information",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
];

async function main() {
  const input: InputItem[] = [
    {
      type: "message",
      role: "user",
      content: [textBlock("What's the weather in Hangzhou?")],
    },
  ];

  let maxRounds = 5;

  while (maxRounds-- > 0) {
    console.log(`\n--- Round ${5 - maxRounds} ---`);
    console.log(`Input items: ${input.length}`);

    const response = await collectStream(client.stream({ input, tools, toolChoice: "auto" }));

    console.log(`Stop reason: ${response.stopReason}`);

    if (response.stopReason === "tool_call") {
      input.push(...response.replay);

      for (const call of response.toolCalls) {
        const result = await runTool(call);
        input.push({
          type: "tool_result",
          callId: call.id,
          toolName: call.name,
          outcome: "success",
          content: [jsonBlock(result)],
        });
      }
    } else {
      console.log(`\nFinal response: ${response.text}`);
      console.log(`Usage: ${JSON.stringify(response.usage)}`);
      break;
    }
  }
}

main().catch(console.error);
