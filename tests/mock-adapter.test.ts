import { describe, expect, it } from "bun:test";

import { MockAdapter, collectStream, createAIClient } from "../src/index.js";

describe("MockAdapter", () => {
  it("should return configured response when keyword matches", async () => {
    const adapter = new MockAdapter({
      rules: [
        {
          keywords: ["退款", "refund"],
          response: "退款申请已收到，我们会在 1 个工作日内处理。",
        },
      ],
      defaultResponse: "未命中规则",
    });

    const result = await collectStream(
      adapter.stream({
        model: "mock-model",
        requestId: "mock-1",
        input: [{ type: "message", role: "user", content: [{ type: "text", text: "我要申请退款" }] }],
      }),
    );

    expect(result.text).toBe("退款申请已收到，我们会在 1 个工作日内处理。");
    expect(result.backend.adapter).toBe("mock");
    expect(result.backend.isSyntheticStream).toBe(true);
    expect(result.auxiliary?.providerMetadata?.matched).toBe(true);
    expect(result.auxiliary?.providerMetadata?.matchedKeyword).toBe("退款");
  });

  it("should fall back to default response when no keyword matches", async () => {
    const adapter = new MockAdapter({
      rules: [{ keywords: ["订单"], response: "请提供订单号。" }],
      defaultResponse: "暂时无法识别你的问题。",
    });

    const result = await collectStream(
      adapter.stream({
        model: "mock-model",
        requestId: "mock-2",
        input: [{ type: "message", role: "user", content: [{ type: "text", text: "你好" }] }],
      }),
    );

    expect(result.text).toBe("暂时无法识别你的问题。");
    expect(result.auxiliary?.providerMetadata?.matched).toBe(false);
  });

  it("should respect caseSensitive rules", async () => {
    const adapter = new MockAdapter({
      rules: [
        { keywords: ["VIP"], response: "命中大写 VIP", caseSensitive: true },
        { keywords: ["vip"], response: "命中小写 vip", caseSensitive: true },
      ],
    });

    const upper = await collectStream(
      adapter.stream({
        model: "mock-model",
        requestId: "mock-3",
        input: [{ type: "message", role: "user", content: [{ type: "text", text: "我是 VIP 用户" }] }],
      }),
    );
    const lower = await collectStream(
      adapter.stream({
        model: "mock-model",
        requestId: "mock-4",
        input: [{ type: "message", role: "user", content: [{ type: "text", text: "我是 vip 用户" }] }],
      }),
    );

    expect(upper.text).toBe("命中大写 VIP");
    expect(lower.text).toBe("命中小写 vip");
  });

  it("should work through createAIClient", async () => {
    const client = createAIClient({
      adapter: new MockAdapter({
        rules: [{ keywords: ["帮助"], response: "这里是帮助中心模板回复。" }],
      }),
      model: "mock-model",
    });

    const result = await collectStream(
      client.stream({
        input: [{ type: "message", role: "user", content: [{ type: "text", text: "我需要帮助" }] }],
      }),
    );

    expect(result.text).toBe("这里是帮助中心模板回复。");
  });
});
