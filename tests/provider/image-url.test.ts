import { describe, expect, it } from "bun:test";

import { isHttpOrHttpsUrl, parseImageDataUrl } from "../../src/provider/image-url.js";

describe("image-url helpers", () => {
  it("should accept http(s) URLs with a host", () => {
    expect(isHttpOrHttpsUrl("https://example.com/cat.png")).toBe(true);
    expect(isHttpOrHttpsUrl("http://localhost:8080/a.jpg")).toBe(true);
    expect(isHttpOrHttpsUrl("file:///tmp/cat.png")).toBe(false);
    expect(isHttpOrHttpsUrl("not a url")).toBe(false);
  });

  it("should parse supported image data URLs", () => {
    expect(parseImageDataUrl("data:image/png;base64,aGVsbG8=")).toEqual({
      mediaType: "image/png",
      data: "aGVsbG8=",
    });
    expect(parseImageDataUrl("data:IMAGE/JPEG;base64,abc123")).toEqual({
      mediaType: "image/jpeg",
      data: "abc123",
    });
  });

  it("should reject unsupported or malformed data URLs", () => {
    expect(parseImageDataUrl("data:image/svg+xml;base64,abc")).toBeNull();
    expect(parseImageDataUrl("data:image/png;base64,")).toBeNull();
    expect(parseImageDataUrl("data:text/plain;base64,abc")).toBeNull();
    expect(parseImageDataUrl("https://example.com/cat.png")).toBeNull();
  });
});
