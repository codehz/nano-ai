/**
 * 示例 1：单轮流式输出
 *
 * 展示最核心的用法：
 * 1. 创建 adapter + client
 * 2. 发起流式请求
 * 3. 逐事件消费（消息 delta 实时打印）
 * 4. 用 collectStream() 收尾聚合
 */

import { createAIClient, collectStream, ResponsesAdapter } from "../src/index.js";

// ── 1. 创建 adapter ────────────────────────────────────────
// 注意：生产环境请在环境变量中配置 API key
const adapter = new ResponsesAdapter({
  apiKey: process.env.OPENAI_API_KEY ?? "sk-your-key-here",
});

// ── 2. 创建 client ─────────────────────────────────────────
const client = createAIClient({
  adapter,
  model: "gpt-4o",
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
        content: [{ type: "text", text: "What is the capital of France?" }],
      },
    ],
  });

  console.log("\n--- Streaming events ---\n");

  // 逐事件消费（适用于实时 UI 更新）
  for await (const event of stream) {
    switch (event.type) {
      case "response.started":
        console.log(`[started] model: ${event.model}`);
        break;
      case "message.delta":
        // 实时输出文本
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

  // ── 4. 或用 collectStream 直接拿最终结果 ──────────────
  // 重新发起相同请求（演示用）
  const response = await collectStream(
    client.stream({
      instructions: "You are a helpful assistant.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "text", text: "What is 2+2?" }],
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
