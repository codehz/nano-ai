/**
 * provider-request-options 合并 helper 单测
 */

import { describe, it, expect } from "bun:test";
import { applyExtraBody, mergeProviderHeaders } from "../src/helpers/provider-request-options.js";

describe("mergeProviderHeaders", () => {
  it("returns base when custom is undefined", () => {
    const base = { Authorization: "Bearer a", "Content-Type": "application/json" };
    expect(mergeProviderHeaders(base)).toBe(base);
  });

  it("lets custom headers override base keys and add new ones", () => {
    expect(
      mergeProviderHeaders(
        { Authorization: "Bearer a", "Content-Type": "application/json" },
        { Authorization: "Bearer b", "X-Trace": "1" },
      ),
    ).toEqual({
      Authorization: "Bearer b",
      "Content-Type": "application/json",
      "X-Trace": "1",
    });
  });
});

describe("applyExtraBody", () => {
  it("returns body when extraBody is undefined", () => {
    const body = { model: "gpt", stream: true as const };
    expect(applyExtraBody(body)).toBe(body);
  });

  it("shallow-merges extra fields and overrides same top-level keys", () => {
    const merged = applyExtraBody(
      { model: "gpt", temperature: 0.5, stream: true as const },
      { top_p: 0.9, temperature: 0.1 },
    ) as Record<string, unknown>;
    expect(merged).toEqual({
      model: "gpt",
      temperature: 0.1,
      stream: true,
      top_p: 0.9,
    });
  });
});
