/**
 * 示例 2：多轮对话（下游自己做 replay）
 *
 * 展示调用方如何保留 response.replay 并在下一轮带回。
 * 这是唯一推荐的多轮方式 — 库不托管会话状态。
 *
 * 该示例使用 MockAdapter，直接验证 replay 续接是否正确。
 */

import { MockAdapter, assertMockRequest, collectStream, createAIClient, textBlock } from "../src/index.js";

import type { InputItem } from "../src/index.js";

const adapter = new MockAdapter({
  handler: async function* (request, context) {
    if (context.turnIndex === 0) {
      assertMockRequest(
        request,
        {
          ordered: true,
          items: [{ type: "message", role: "user", textIncludes: "My name is Alice." }],
        },
        context,
      );
      yield { type: "message", content: "Nice to meet you, Alice." };
      return;
    }

    if (context.turnIndex === 1) {
      assertMockRequest(
        request,
        {
          ordered: true,
          requireReplayFromPreviousTurn: true,
          items: [
            { type: "message", role: "user", textIncludes: "My name is Alice." },
            { type: "message", role: "assistant", textIncludes: "Nice to meet you, Alice." },
            { type: "message", role: "user", textIncludes: "What's my name?" },
          ],
        },
        context,
      );
      yield { type: "message", content: "Your name is Alice." };
      return;
    }

    assertMockRequest(
      request,
      {
        ordered: true,
        requireReplayFromPreviousTurn: true,
        items: [
          { type: "message", role: "user", textIncludes: "My name is Alice." },
          { type: "message", role: "assistant", textIncludes: "Nice to meet you, Alice." },
          { type: "message", role: "user", textIncludes: "What's my name?" },
          { type: "message", role: "assistant", textIncludes: "Your name is Alice." },
          { type: "message", role: "user", textIncludes: "Tell me a joke." },
        ],
      },
      context,
    );
    yield {
      type: "message",
      content: "Why do programmers confuse Halloween and Christmas? Because OCT 31 === DEC 25.",
    };
  },
});

const client = createAIClient({
  adapter,
  model: "mock-model",
});

async function main() {
  const transcript: InputItem[] = [];

  console.log("\n=== Round 1 ===");

  transcript.push({
    type: "message",
    role: "user",
    content: [textBlock("My name is Alice.")],
  });

  const r1 = await collectStream(client.stream({ input: transcript }));
  console.log(`Assistant: ${r1.text}`);

  transcript.push(...r1.replay);

  console.log("\n=== Round 2 ===");

  transcript.push({
    type: "message",
    role: "user",
    content: [textBlock("What's my name?")],
  });

  const r2 = await collectStream(client.stream({ input: transcript }));
  console.log(`Assistant: ${r2.text}`);

  transcript.push(...r2.replay);

  console.log("\n=== Round 3 ===");

  transcript.push({
    type: "message",
    role: "user",
    content: [textBlock("Tell me a joke.")],
  });

  const r3 = await collectStream(client.stream({ input: transcript }));
  console.log(`Assistant: ${r3.text}`);

  console.log("\n=== Done ===");
  console.log(`Total rounds: 3`);
  console.log(`Final transcript length: ${transcript.length} items`);
}

main().catch(console.error);
