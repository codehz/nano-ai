/**
 * Canonical replay / extractText 纯函数 — 大块 A 权威入口
 */

import { describe, expect, it } from "bun:test";

import {
  extractText,
  messageItem,
  opaqueItem,
  reasoningItem,
  replayFromOutput,
  serverToolCallItem,
  serverToolDiscoveryItem,
  serverToolResultItem,
  textBlock,
  toolCallItem,
} from "../../src/index.js";

describe("replayFromOutput", () => {
  it("should pass through message, reasoning, and tool_call items in order", () => {
    const output = [
      messageItem([textBlock("Hello")], { id: "m1" }),
      reasoningItem([textBlock("thinking")], "full", "r1"),
      toolCallItem("tc1", "search", "{}"),
    ];
    const replay = replayFromOutput(output);
    expect(replay).toHaveLength(3);
    expect(replay[0]!.type).toBe("message");
    expect(replay[1]!.type).toBe("reasoning");
    expect(replay[2]!.type).toBe("tool_call");
    expect(replay).toEqual(output);
  });

  it("should pass through server tool items and discovery", () => {
    const output = [
      serverToolCallItem("stc1", "web_search", { name: "search", argumentsText: "{}" }),
      serverToolResultItem("stc1", "web_search", "success", [textBlock("ok")]),
      serverToolDiscoveryItem("disc1", "mcp-server", [{ name: "tool_a" }]),
    ];
    const replay = replayFromOutput(output);
    expect(replay).toEqual(output);
  });

  it("should preserve opaque items", () => {
    const output = [opaqueItem("responses", "replay", { id: "cont-123" })];
    const replay = replayFromOutput(output);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toEqual(output[0]);
  });

  it("should return empty array for empty output", () => {
    expect(replayFromOutput([])).toEqual([]);
  });
});

describe("extractText", () => {
  it("should concatenate text from message items only", () => {
    const text = extractText([
      reasoningItem([textBlock("ignore me")], "full", "r1"),
      messageItem([textBlock("Hello")], { id: "m1" }),
      toolCallItem("tc1", "search", "{}"),
      messageItem([textBlock(" world")], { id: "m2" }),
    ]);
    expect(text).toBe("Hello world");
  });

  it("should ignore non-text content blocks inside messages", () => {
    const text = extractText([
      messageItem([{ type: "json", json: { a: 1 } }, textBlock("kept"), { type: "opaque", payload: {} }], {
        id: "m1",
      }),
    ]);
    expect(text).toBe("kept");
  });

  it("should return empty string when there is no message text", () => {
    expect(extractText([toolCallItem("tc1", "x", "{}")])).toBe("");
    expect(extractText([])).toBe("");
  });
});
