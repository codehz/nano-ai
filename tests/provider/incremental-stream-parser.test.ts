import { describe, expect, it } from "bun:test";

import { IncrementalStreamParser, splitLines, splitSSEFrames } from "../../src/provider/transport/parser.js";
const encoder = new TextEncoder();

function jsonParser(raw: string) {
  const value = raw.trim();
  if (!value) return { status: "ignored" } as const;
  try {
    return { status: "parsed", value: JSON.parse(value) as unknown } as const;
  } catch {
    return { status: "malformed" } as const;
  }
}

describe("IncrementalStreamParser", () => {
  it("preserves split UTF-8 and partial lines", () => {
    const parser = new IncrementalStreamParser(splitLines, jsonParser);
    const bytes = encoder.encode('{"text":"你好"}\n');
    const splitAt = bytes.indexOf(0xe5) + 1;

    expect(parser.feed(bytes.slice(0, splitAt))).toEqual({ items: [], malformed: 0 });
    expect(parser.feed(bytes.slice(splitAt))).toEqual({ items: [{ text: "你好" }], malformed: 0 });
    expect(parser.flush()).toEqual({ items: [], malformed: 0 });
    expect(parser.getRemaining()).toBe("");
  });

  it("flushes an unterminated final item and counts malformed input", () => {
    const parser = new IncrementalStreamParser(splitLines, jsonParser);

    expect(parser.feed(encoder.encode('{"ok":true}\ninvalid'))).toEqual({
      items: [{ ok: true }],
      malformed: 0,
    });
    expect(parser.flush()).toEqual({ items: [], malformed: 1 });
  });

  it("splits SSE frames across chunks and normalizes CRLF", () => {
    const parser = new IncrementalStreamParser(splitSSEFrames, (frame) => ({
      status: "parsed",
      value: frame,
    }));

    expect(parser.feed(encoder.encode("event: one\r\ndata: 1\r\n"))).toEqual({ items: [], malformed: 0 });
    expect(parser.feed(encoder.encode("\r\nevent: two\ndata: 2\n\n"))).toEqual({
      items: ["event: one\ndata: 1", "event: two\ndata: 2"],
      malformed: 0,
    });
  });
});
