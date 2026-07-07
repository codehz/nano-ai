/**
 * 示例 3：手动工具循环
 *
 * 展示库的推荐工具调用模式：
 * 1. 模型返回 tool_call
 * 2. 调用方执行工具
 * 3. 调用方将 tool_result 放入下一轮 input
 * 4. 再次调用 client.stream()
 */

import {
  createAIClient,
  collectStream,
  ResponsesAdapter,
  textBlock,
  jsonBlock,
} from "../src/index.js";

import type { InputItem, ToolCallItem } from "../src/index.js";

const adapter = new ResponsesAdapter({
  apiKey: process.env.OPENAI_API_KEY ?? "sk-your-key-here",
});

const client = createAIClient({
  adapter,
  model: "gpt-4o",
});

// ── 模拟工具执行 ──────────────────────────────────────────
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

// ── 工具声明 ─────────────────────────────────────────────
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

    const response = await collectStream(
      client.stream({ input, tools, toolChoice: "auto" }),
    );

    console.log(`Stop reason: ${response.stopReason}`);

    if (response.stopReason === "tool_call") {
      // 模型请求调用工具 → 执行工具 → 构造 tool_result
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
      // 继续下一轮
    } else {
      // 模型正常结束
      console.log(`\nFinal response: ${response.text}`);
      console.log(`Usage: ${JSON.stringify(response.usage)}`);
      break;
    }
  }
}

main().catch(console.error);
