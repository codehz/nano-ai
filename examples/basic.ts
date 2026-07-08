/**
 * 示例 1：单轮流式输出
 *
 * 展示最核心的用法：
 * 1. 创建 adapter + client
 * 2. 发起流式请求
 * 3. 逐事件消费（消息 delta 实时打印）
 * 4. 用 collectStream() 收尾聚合
 *
 * 该示例使用 MockAdapter，便于直接运行并观察 canonical API 的事件形态。
 */

import { MockAdapter, collectStream, createAIClient, textBlock, withMockStreaming } from "../src/index.js";

// ── 1. 创建 adapter ────────────────────────────────────────
const adapter = new MockAdapter({
  handler: withMockStreaming(
    async function* (_request, context) {
      if (context.turnIndex === 0) {
        yield { type: "message", content: "Paris is the capital of France." };
        yield { type: "warning", message: "mock backend: scripted response", code: "MOCK_DEMO" };
        yield { type: "auxiliary", usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } };
        return;
      }

      yield { type: "message", content: "2 + 2 = 4." };
      yield {
        type: "complete",
        usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
        providerMetadata: { scenario: "basic-example" },
      };
    },
    {
      chunkSize: 1,
      charsPerSecond: 24,
    },
  ),
});

// ── 2. 创建 client ─────────────────────────────────────────
const client = createAIClient({
  adapter,
  model: "mock-model",
  defaults: {
    maxOutputTokens: 500,
  },
});

// ── 3. 发起流式请求 ────────────────────────────────────────
async function main() {
  const stream = client.stream({
    instructions: "You are a helpful assistant.",
    input: [
      {
        type: "message",
        role: "user",
        content: [textBlock("What is the capital of France?")],
      },
    ],
  });

  console.log("\n--- Streaming events ---\n");

  for await (const event of stream) {
    switch (event.type) {
      case "response.started":
        console.log(`[started] model: ${event.model}`);
        break;
      case "message.delta":
        process.stdout.write(event.delta.text);
        break;
      case "response.warning":
        console.warn(`[warning] ${event.message}`);
        break;
      case "response.auxiliary":
        if (event.usage) {
          console.log(`\n[usage] input: ${event.usage.inputTokens}, output: ${event.usage.outputTokens}`);
        }
        break;
      case "response.completed":
        console.log(`\n\n--- Done ---`);
        console.log(`stopReason: ${event.response.stopReason}`);
        break;
    }
  }

  const response = await collectStream(
    client.stream({
      instructions: "You are a helpful assistant.",
      input: [
        {
          type: "message",
          role: "user",
          content: [textBlock("What is 2+2?")],
        },
      ],
    }),
  );

  console.log(`\n--- Aggregated ---`);
  console.log(`text: ${response.text}`);
  console.log(`toolCalls: ${response.toolCalls.length}`);
  console.log(`usage: ${JSON.stringify(response.usage)}`);
  console.log(`backend: ${response.backend.adapter} (synthetic: ${response.backend.isSyntheticStream})`);
}

main().catch(console.error);
