/**
 * AuxiliaryCollector 测试
 *
 * 验证辅助信息采集行为：分层优先级、bounded lookup、降级安全。
 */

import { describe, it, expect } from "bun:test";
import { AuxiliaryCollector } from "../src/index.js";

// ── 基础行为 ──────────────────────────────────────────────────

describe("AuxiliaryCollector - basic", () => {
  it("should return empty when nothing recorded", () => {
    const c = new AuxiliaryCollector();
    const result = c.build();
    expect(result.usage).toBeUndefined();
    expect(result.billing).toBeUndefined();
    expect(result.auxiliary).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  it("should record usage with source", () => {
    const c = new AuxiliaryCollector();
    c.recordUsage({ inputTokens: 10, outputTokens: 5 }, "stream");

    const result = c.build();
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
    expect(result.auxiliary?.usageSource).toBe("stream");
  });

  it("should record billing with source", () => {
    const c = new AuxiliaryCollector();
    c.recordBilling({ amount: 0.01, currency: "USD", isEstimated: false, source: "provider" }, "final");

    const result = c.build();
    expect(result.billing?.amount).toBe(0.01);
    expect(result.billing?.isEstimated).toBe(false);
    expect(result.auxiliary?.billingSource).toBe("final");
  });

  it("should record warnings", () => {
    const c = new AuxiliaryCollector();
    c.recordWarning("usage missing");
    c.recordWarning("billing degraded");

    const result = c.build();
    expect(result.warnings).toEqual(["usage missing", "billing degraded"]);
  });

  it("should record provider metadata", () => {
    const c = new AuxiliaryCollector();
    c.recordMetadata({ requestId: "req-123", serviceTier: "default" });

    const result = c.build();
    expect(result.auxiliary?.providerMetadata?.requestId).toBe("req-123");
  });

  it("should record raw provider usage", () => {
    const c = new AuxiliaryCollector();
    c.recordUsage({ inputTokens: 5 }, "stream", { prompt_tokens: 5 });

    const result = c.build();
    expect(result.auxiliary?.providerUsage).toEqual({ prompt_tokens: 5 });
  });
});

// ── 覆盖顺序 ──────────────────────────────────────────────────

describe("AuxiliaryCollector - merge order", () => {
  it("should merge usage from multiple calls (last wins)", () => {
    const c = new AuxiliaryCollector();
    c.recordUsage({ inputTokens: 10 }, "stream");
    c.recordUsage({ outputTokens: 5 }, "final");

    const result = c.build();
    expect(result.usage?.inputTokens).toBe(10);  // preserved from first
    expect(result.usage?.outputTokens).toBe(5);   // added by second
    expect(result.auxiliary?.usageSource).toBe("final"); // last source wins
  });

  it("should later billing override earlier fields", () => {
    const c = new AuxiliaryCollector();
    c.recordBilling({ amount: 0.01, currency: "USD", isEstimated: false, source: "provider" }, "stream");
    c.recordBilling({ amount: 0.02 }, "final");

    const result = c.build();
    expect(result.billing?.amount).toBe(0.02);
    expect(result.billing?.currency).toBe("USD"); // preserved
  });
});

// ── Lookup ────────────────────────────────────────────────────

describe("AuxiliaryCollector - lookup", () => {
  it("should populate usage from successful lookup", async () => {
    const c = new AuxiliaryCollector();
    await c.tryLookup(async () => ({
      usage: { totalTokens: 100 },
    }));

    const result = c.build();
    expect(result.usage?.totalTokens).toBe(100);
    expect(result.auxiliary?.usageSource).toBe("lookup");
  });

  it("should populate billing from successful lookup", async () => {
    const c = new AuxiliaryCollector();
    await c.tryLookup(async () => ({
      billing: { amount: 0.05, currency: "USD", isEstimated: false, source: "lookup" },
    }));

    const result = c.build();
    expect(result.billing?.amount).toBe(0.05);
  });

  it("should only attempt lookup once", async () => {
    let callCount = 0;
    const c = new AuxiliaryCollector();

    await c.tryLookup(async () => {
      callCount++;
      return { usage: { inputTokens: 10 } };
    });

    await c.tryLookup(async () => {
      callCount++;
      return { usage: { inputTokens: 20 } };
    });

    expect(callCount).toBe(1);
    const result = c.build();
    expect(result.usage?.inputTokens).toBe(10);
  });

  it("should record warning on lookup failure", async () => {
    const c = new AuxiliaryCollector();
    await c.tryLookup(async () => {
      throw new Error("API unavailable");
    });

    const result = c.build();
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain("Auxiliary lookup failed");
  });

  it("should not throw on lookup failure", async () => {
    const c = new AuxiliaryCollector();
    // Should not throw
    await c.tryLookup(async () => {
      throw new Error("fail");
    });
    // Should complete normally
    expect(true).toBe(true);
  });

  it("should timeout on slow lookup", async () => {
    const c = new AuxiliaryCollector();
    await c.tryLookup(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { usage: { totalTokens: 99 } };
    }, 10); // 10ms timeout

    const result = c.build();
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain("Lookup timed out");
  });

  it("should preserve pre-lookup data when lookup fails", async () => {
    const c = new AuxiliaryCollector();
    c.recordUsage({ inputTokens: 5 }, "stream");

    await c.tryLookup(async () => {
      throw new Error("fail");
    });

    const result = c.build();
    expect(result.usage?.inputTokens).toBe(5); // preserved
    expect(result.auxiliary?.usageSource).toBe("stream");
  });
});

// ── 集成场景 ──────────────────────────────────────────────────

describe("AuxiliaryCollector - integration scenarios", () => {
  it("should simulate best-effort collection pipeline", async () => {
    const c = new AuxiliaryCollector();

    // 优先级 1: 流事件中的 usage
    c.recordUsage({ inputTokens: 10, outputTokens: 5 }, "stream", { input_tokens: 10, output_tokens: 5 });

    // 优先级 2: header 中的 metadata
    c.recordMetadata({ "x-request-id": "abc-123" });

    // 优先级 4: follow-up lookup (补 billing)
    await c.tryLookup(async () => ({
      billing: { amount: 0.002, currency: "USD", isEstimated: false, source: "lookup" },
    }));

    const result = c.build();
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
    expect(result.billing?.amount).toBe(0.002);
    expect(result.auxiliary?.usageSource).toBe("stream");
    expect(result.auxiliary?.billingSource).toBe("lookup");
    expect(result.auxiliary?.providerUsage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(result.auxiliary?.providerMetadata?.["x-request-id"]).toBe("abc-123");
    expect(result.warnings).toBeUndefined(); // all succeeded
  });

  it("should not block main chain when lookup fails", async () => {
    const c = new AuxiliaryCollector();

    // 主线 usage 已采集
    c.recordUsage({ inputTokens: 10 }, "stream");

    // lookup 失败
    await c.tryLookup(async () => {
      throw new Error("timeout");
    });

    const result = c.build();
    // 主线数据不受影响
    expect(result.usage?.inputTokens).toBe(10);
    // lookup 失败有 warning
    expect(result.warnings).toHaveLength(1);
  });

  it("should handle all empty gracefully", () => {
    const c = new AuxiliaryCollector();
    // 不记录任何数据
    const result = c.build();
    expect(result.usage).toBeUndefined();
    expect(result.billing).toBeUndefined();
    expect(result.auxiliary).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });
});
