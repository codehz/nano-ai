/**
 * 示例 2：多轮对话（下游自己做 replay）
 *
 * 展示调用方如何保留 response.replay 并在下一轮带回。
 * 这是唯一推荐的多轮方式 — 库不托管会话状态。
 */

import {
  createAIClient,
  collectStream,
  ResponsesAdapter,
  textBlock,
} from "../src/index.js";

import type { InputItem } from "../src/index.js";

const adapter = new ResponsesAdapter({
  apiKey: process.env.OPENAI_API_KEY ?? "sk-your-key-here",
});

const client = createAIClient({
  adapter,
  model: "gpt-4o",
});

async function main() {
  // 调用方维护的完整 transcript
  const transcript: InputItem[] = [];

  // ── Round 1 ──────────────────────────────────────────────
  console.log("\n=== Round 1 ===");

  transcript.push({
    type: "message",
    role: "user",
    content: [textBlock("My name is Alice.")],
  });

  const r1 = await collectStream(
    client.stream({ input: transcript }),
  );
  console.log(`Assistant: ${r1.text}`);

  // 将本轮 replay 追加到 transcript
  transcript.push(...r1.replay);

  // ── Round 2 ──────────────────────────────────────────────
  console.log("\n=== Round 2 ===");

  transcript.push({
    type: "message",
    role: "user",
    content: [textBlock("What's my name?")],
  });

  const r2 = await collectStream(
    client.stream({ input: transcript }),
  );
  console.log(`Assistant: ${r2.text}`);

  transcript.push(...r2.replay);

  // ── Round 3（可选窗口裁剪） ─────────────────────────────
  console.log("\n=== Round 3 ===");

  transcript.push({
    type: "message",
    role: "user",
    content: [textBlock("Tell me a joke.")],
  });

  const r3 = await collectStream(
    client.stream({ input: transcript }),
  );
  console.log(`Assistant: ${r3.text}`);

  console.log("\n=== Done ===");
  console.log(`Total rounds: 3`);
  console.log(`Final transcript length: ${transcript.length} items`);
}

main().catch(console.error);
