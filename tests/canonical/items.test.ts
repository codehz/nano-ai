/**
 * Canonical item 构造 helper — 大块 A 权威入口
 */

import { describe, expect, it } from "bun:test";

import {
  jsonBlock,
  messageItem,
  opaqueItem,
  reasoningItem,
  serverToolCallItem,
  serverToolDiscoveryItem,
  serverToolResultItem,
  textBlock,
  toolCallItem,
  toolResultItem,
} from "../../src/index.js";

describe("item constructors", () => {
  it("messageItem should default to assistant role", () => {
    const item = messageItem([textBlock("hello")]);
    expect(item).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("messageItem should accept role override", () => {
    const item = messageItem([textBlock("hi")], { role: "user", id: "u1" });
    expect(item.role).toBe("user");
    expect(item.id).toBe("u1");
  });

  it("reasoningItem should default visibility to full", () => {
    const item = reasoningItem([textBlock("thinking")]);
    expect(item.type).toBe("reasoning");
    expect(item.visibility).toBe("full");
    expect(item.id).toBeUndefined();
  });

  it("reasoningItem should accept visibility and id", () => {
    const item = reasoningItem([textBlock("step 1")], "summary", "r1");
    expect(item.visibility).toBe("summary");
    expect(item.id).toBe("r1");
  });

  it("toolCallItem should create a ToolCallItem", () => {
    const item = toolCallItem("tc1", "get_weather", '{"city":"Hangzhou"}');
    expect(item).toEqual({
      type: "tool_call",
      id: "tc1",
      name: "get_weather",
      argumentsText: '{"city":"Hangzhou"}',
    });
  });

  it("toolResultItem should create a ToolResultItem", () => {
    const item = toolResultItem("tc1", "get_weather", "success", [jsonBlock({ temp: 28 })]);
    expect(item.type).toBe("tool_result");
    expect(item.callId).toBe("tc1");
    expect(item.toolName).toBe("get_weather");
    expect(item.outcome).toBe("success");
    expect(item.content).toHaveLength(1);
  });

  it("opaqueItem should create an OpaqueItem", () => {
    const item = opaqueItem("responses", "replay", { id: "cont-123" }, "op-1");
    expect(item).toEqual({
      type: "opaque",
      id: "op-1",
      source: "responses",
      purpose: "replay",
      payload: { id: "cont-123" },
    });
  });

  it("serverToolCallItem should create a ServerToolCallItem", () => {
    const item = serverToolCallItem("stc1", "web_search", {
      name: "search",
      argumentsText: '{"q":"x"}',
      status: "completed",
    });
    expect(item.type).toBe("server_tool_call");
    expect(item.id).toBe("stc1");
    expect(item.tool).toBe("web_search");
    expect(item.name).toBe("search");
    expect(item.argumentsText).toBe('{"q":"x"}');
    expect(item.status).toBe("completed");
  });

  it("serverToolResultItem should create a ServerToolResultItem", () => {
    const item = serverToolResultItem("stc1", "web_search", "success", [textBlock("hits")]);
    expect(item.type).toBe("server_tool_result");
    expect(item.callId).toBe("stc1");
    expect(item.tool).toBe("web_search");
    expect(item.outcome).toBe("success");
  });

  it("serverToolDiscoveryItem should fix tool to mcp", () => {
    const item = serverToolDiscoveryItem("d1", "label", [{ name: "tool_a", description: "A" }]);
    expect(item.type).toBe("server_tool_discovery");
    expect(item.tool).toBe("mcp");
    expect(item.serverLabel).toBe("label");
    expect(item.tools).toHaveLength(1);
  });
});
