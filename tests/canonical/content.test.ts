/**
 * Canonical content 纯函数 — 大块 A 权威入口
 * (adapter-base 中有历史重复用例，以本目录为准)
 */

import { describe, expect, it } from "bun:test";

import {
  blockToText,
  contentBlocksToText,
  imageBlock,
  jsonBlock,
  opaqueBlock,
  textBlock,
} from "../../src/index.js";

describe("content block constructors", () => {
  it("textBlock should create a text block", () => {
    expect(textBlock("hello")).toEqual({ type: "text", text: "hello" });
  });

  it("jsonBlock should create a json block", () => {
    expect(jsonBlock({ key: "val" })).toEqual({ type: "json", json: { key: "val" } });
  });

  it("imageBlock should create an image block", () => {
    expect(imageBlock("https://example.com/img.png")).toEqual({
      type: "image",
      imageUrl: "https://example.com/img.png",
    });
  });

  it("opaqueBlock should create an opaque block", () => {
    const payload = { raw: true };
    expect(opaqueBlock(payload)).toEqual({ type: "opaque", payload });
  });
});

describe("blockToText", () => {
  it("should return text for text blocks", () => {
    expect(blockToText(textBlock("hi"))).toBe("hi");
  });

  it("should JSON-stringify json blocks", () => {
    expect(blockToText(jsonBlock({ a: 1 }))).toBe('{"a":1}');
  });

  it("should return empty string for image and opaque blocks", () => {
    expect(blockToText(imageBlock("https://example.com/x.png"))).toBe("");
    expect(blockToText(opaqueBlock({ x: 1 }))).toBe("");
  });
});

describe("contentBlocksToText", () => {
  it("should return empty string for empty array", () => {
    expect(contentBlocksToText([])).toBe("");
  });

  it("should return single block text without trailing newline", () => {
    expect(contentBlocksToText([textBlock("only")])).toBe("only");
  });

  it("should join multiple blocks with newlines", () => {
    expect(contentBlocksToText([textBlock("a"), textBlock("b"), jsonBlock({ n: 2 })])).toBe('a\nb\n{"n":2}');
  });

  it("should skip non-text/json blocks as empty segments", () => {
    expect(contentBlocksToText([textBlock("x"), imageBlock("https://example.com/i.png"), textBlock("y")])).toBe(
      "x\n\ny",
    );
  });
});
