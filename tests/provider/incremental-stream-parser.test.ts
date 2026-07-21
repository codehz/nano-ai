import { describe, expect, it } from "bun:test";

import {
  IncrementalStreamParser,
  splitLines,
  splitSSEFrames,
  parseDataLineSse,
  createDataLineSseParser,
  createSseJsonParser,
} from "../../src/provider/transport/parser.js";

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
      status: "parsed" as const,
      value: frame,
    }));

    expect(parser.feed(encoder.encode("event: one\r\ndata: 1\r\n"))).toEqual({ items: [], malformed: 0 });
    expect(parser.feed(encoder.encode("\r\nevent: two\ndata: 2\n\n"))).toEqual({
      items: ["event: one\ndata: 1", "event: two\ndata: 2"],
      malformed: 0,
    });
  });

  it("holds half SSE frames and lone CR until a blank-line boundary arrives", () => {
    const parser = new IncrementalStreamParser(splitSSEFrames, (frame) => ({
      status: "parsed" as const,
      value: frame,
    }));

    expect(parser.feed(encoder.encode("event: a\ndata: 1"))).toEqual({ items: [], malformed: 0 });
    expect(parser.getRemaining()).toBe("event: a\ndata: 1");
    expect(parser.feed(encoder.encode("\n"))).toEqual({ items: [], malformed: 0 });
    expect(parser.feed(encoder.encode("\n"))).toEqual({ items: ["event: a\ndata: 1"], malformed: 0 });

    expect(parser.feed(encoder.encode("event: b\r"))).toEqual({ items: [], malformed: 0 });
    expect(parser.feed(encoder.encode("\ndata: 2\r\n"))).toEqual({ items: [], malformed: 0 });
    expect(parser.feed(encoder.encode("\r\n"))).toEqual({ items: ["event: b\ndata: 2"], malformed: 0 });
  });

  it("accepts mixed blank-line terminators for SSE frames", () => {
    const parser = new IncrementalStreamParser(splitSSEFrames, (frame) => ({
      status: "parsed" as const,
      value: frame,
    }));

    // \r\n\n and \n\r\n mixed with pure LF frames
    const stream = "event: a\r\ndata: 1\r\n\nevent: b\ndata: 2\n\r\nevent: c\ndata: 3\n\n";
    expect(parser.feed(encoder.encode(stream))).toEqual({
      items: ["event: a\ndata: 1", "event: b\ndata: 2", "event: c\ndata: 3"],
      malformed: 0,
    });
  });

  it("assembles many tiny chunks into complete data lines", () => {
    const parser = createDataLineSseParser<{ n: number }>();
    const line = 'data: {"n":42}\n';
    for (const ch of line) {
      const result = parser.feed(encoder.encode(ch));
      if (ch !== "\n") {
        expect(result).toEqual({ items: [], malformed: 0 });
      } else {
        expect(result).toEqual({ items: [{ n: 42 }], malformed: 0 });
      }
    }
    expect(parser.flush()).toEqual({ items: [], malformed: 0 });
  });
});

describe("splitSSEFrames", () => {
  it("leaves incomplete tails in rest without whole-buffer rewrite", () => {
    expect(splitSSEFrames("event: x\r\ndata: 1\r\n", false)).toEqual({
      items: [],
      rest: "event: x\r\ndata: 1\r\n",
    });
    expect(splitSSEFrames("event: x\ndata: 1\n\npartial", false)).toEqual({
      items: ["event: x\ndata: 1"],
      rest: "partial",
    });
  });

  it("flushes trailing frame only when allowEOF", () => {
    expect(splitSSEFrames("event: x\ndata: 1", false)).toEqual({
      items: [],
      rest: "event: x\ndata: 1",
    });
    expect(splitSSEFrames("event: x\ndata: 1", true)).toEqual({
      items: ["event: x\ndata: 1"],
      rest: "",
    });
  });
});

describe("data-line SSE parsers", () => {
  it("ignores [DONE] and non-data lines without counting malformed", () => {
    expect(parseDataLineSse("data: [DONE]")).toEqual({ status: "ignored" });
    expect(parseDataLineSse("event: message")).toEqual({ status: "ignored" });
    expect(parseDataLineSse("")).toEqual({ status: "ignored" });
    expect(parseDataLineSse("data: not-json")).toEqual({ status: "malformed" });
    expect(parseDataLineSse('data: {"ok":true}')).toEqual({ status: "parsed", value: { ok: true } });
  });

  it("parses data lines across partial JSON chunks", () => {
    const parser = createDataLineSseParser<{ id: string }>();
    expect(parser.feed(encoder.encode('data: {"id":'))).toEqual({ items: [], malformed: 0 });
    expect(parser.feed(encoder.encode('"x"}\n'))).toEqual({ items: [{ id: "x" }], malformed: 0 });
    expect(parser.feed(encoder.encode("data: [DONE]\n"))).toEqual({ items: [], malformed: 0 });
    expect(parser.feed(encoder.encode("data: {\n"))).toEqual({ items: [], malformed: 1 });
  });

  it("createDataLineSseParser parses mixed data lines consistently", () => {
    const parser = createDataLineSseParser<unknown>();
    const payload = 'data: {"a":1}\ndata: [DONE]\ndata: bad\ndata: {"b":2}\n';

    expect(parser.feed(encoder.encode(payload))).toEqual({
      items: [{ a: 1 }, { b: 2 }],
      malformed: 1,
    });
    expect(parser.flush()).toEqual({ items: [], malformed: 0 });
  });

  it("createSseJsonParser parses event/data frames", () => {
    const parser = createSseJsonParser();
    expect(parser.feed(encoder.encode('event: ping\r\ndata: {"x":1}\r\n'))).toEqual({
      items: [],
      malformed: 0,
    });
    expect(parser.feed(encoder.encode("\r\n"))).toEqual({
      items: [{ type: "ping", data: { x: 1 } }],
      malformed: 0,
    });
  });
});
