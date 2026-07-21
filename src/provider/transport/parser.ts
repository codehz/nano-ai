export type StreamSplitResult = {
  items: string[];
  rest: string;
};

export type StreamParseResult<T> = { status: "parsed"; value: T } | { status: "ignored" } | { status: "malformed" };

export class IncrementalStreamParser<T> {
  /** Pending decoded fragments; compacted to at most one rest string after each consume. */
  private chunks: string[] = [];
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly split: (buffer: string, allowEOF: boolean) => StreamSplitResult,
    private readonly parse: (item: string) => StreamParseResult<T>,
  ) {}

  feed(value: Uint8Array): { items: T[]; malformed: number } {
    this.chunks.push(this.decoder.decode(value, { stream: true }));
    return this.consume(false);
  }

  flush(): { items: T[]; malformed: number } {
    const tail = this.decoder.decode();
    if (tail.length > 0) this.chunks.push(tail);
    return this.consume(true);
  }

  getRemaining(): string {
    return this.materializeBuffer();
  }

  private materializeBuffer(): string {
    if (this.chunks.length === 0) return "";
    if (this.chunks.length === 1) return this.chunks[0] ?? "";
    return this.chunks.join("");
  }

  private consume(allowEOF: boolean): { items: T[]; malformed: number } {
    const buffer = this.materializeBuffer();
    const split = this.split(buffer, allowEOF);
    this.chunks = split.rest.length > 0 ? [split.rest] : [];
    const items: T[] = [];
    let malformed = 0;

    for (const rawItem of split.items) {
      const result = this.parse(rawItem);
      if (result.status === "parsed") items.push(result.value);
      else if (result.status === "malformed") malformed++;
    }

    return { items, malformed };
  }
}

export function splitLines(buffer: string, allowEOF: boolean): StreamSplitResult {
  const items: string[] = [];
  let cursor = 0;

  while (true) {
    const lineEnd = buffer.indexOf("\n", cursor);
    if (lineEnd === -1) break;
    items.push(buffer.slice(cursor, lineEnd));
    cursor = lineEnd + 1;
  }

  if (allowEOF && cursor < buffer.length) {
    items.push(buffer.slice(cursor));
    cursor = buffer.length;
  }

  return { items, rest: buffer.slice(cursor) };
}

/**
 * Split SSE frames on blank-line boundaries without rewriting the whole buffer.
 * Accepts LF, CRLF, and mixed empty-line terminators; normalizes only extracted frames.
 */
export function splitSSEFrames(buffer: string, allowEOF: boolean): StreamSplitResult {
  const items: string[] = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const boundary = findSseFrameBoundary(buffer, cursor);
    if (boundary === null) break;
    items.push(normalizeSseFrame(buffer.slice(cursor, boundary.start)));
    cursor = boundary.end;
  }

  if (allowEOF && cursor < buffer.length) {
    items.push(normalizeSseFrame(buffer.slice(cursor)));
    cursor = buffer.length;
  }

  return { items, rest: buffer.slice(cursor) };
}

/** Locate blank-line frame end: `\n\n`, `\r\n\r\n`, `\r\n\n`, or `\n\r\n`. */
function findSseFrameBoundary(buffer: string, from: number): { start: number; end: number } | null {
  for (let i = from; i < buffer.length; i++) {
    const c = buffer[i];
    if (c === "\n") {
      if (i + 1 < buffer.length && buffer[i + 1] === "\n") {
        return { start: i, end: i + 2 };
      }
      if (i + 2 < buffer.length && buffer[i + 1] === "\r" && buffer[i + 2] === "\n") {
        return { start: i, end: i + 3 };
      }
    } else if (c === "\r") {
      if (i + 1 < buffer.length && buffer[i + 1] === "\n") {
        if (i + 2 < buffer.length && buffer[i + 2] === "\n") {
          return { start: i, end: i + 3 };
        }
        if (i + 3 < buffer.length && buffer[i + 2] === "\r" && buffer[i + 3] === "\n") {
          return { start: i, end: i + 4 };
        }
      }
    }
  }
  return null;
}

function normalizeSseFrame(frame: string): string {
  return frame.includes("\r") ? frame.replaceAll("\r\n", "\n") : frame;
}

// ── 常用 parse 工厂 ───────────────────────────────────────────

export type SseJsonEvent = { type: string; data: unknown };

/** 解析标准 SSE frame（event: + data:），用于 Messages / Responses。 */
export function parseSseJsonFrame(frame: string): StreamParseResult<SseJsonEvent> {
  let eventType = "";
  let dataStr = "";
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("event: ")) eventType = line.slice(7).trim();
    else if (line.startsWith("data: ")) dataStr += line.slice(6);
  }
  if (!eventType) return { status: "ignored" };
  try {
    const data: unknown = JSON.parse(dataStr);
    return { status: "parsed", value: { type: eventType, data } };
  } catch {
    return { status: "malformed" };
  }
}

export function createSseJsonParser<T extends SseJsonEvent = SseJsonEvent>(): IncrementalStreamParser<T> {
  return new IncrementalStreamParser(splitSSEFrames, (frame) => parseSseJsonFrame(frame) as StreamParseResult<T>);
}

/** OpenAI Chat Completions 简化 SSE：仅 `data: ...` 行，忽略 `[DONE]`。 */
export function parseChatCompletionsDataLine(item: string): StreamParseResult<unknown> {
  const trimmed = item.trim();
  if (!trimmed.startsWith("data: ")) return { status: "ignored" };
  const data = trimmed.slice(6).trim();
  if (data === "[DONE]") return { status: "ignored" };
  try {
    return { status: "parsed", value: JSON.parse(data) as unknown };
  } catch {
    return { status: "malformed" };
  }
}

export function createChatCompletionsSseParser<T>(): IncrementalStreamParser<T> {
  return new IncrementalStreamParser(splitLines, (item) => parseChatCompletionsDataLine(item) as StreamParseResult<T>);
}

/** NDJSON 行解析（Ollama 等）：空行忽略，JSON 失败为 malformed。 */
export function createNdjsonLineParser<T>(isValid: (value: unknown) => value is T): IncrementalStreamParser<T> {
  return new IncrementalStreamParser<T>(splitLines, (item: string): StreamParseResult<T> => {
    const trimmed = item.trim();
    if (!trimmed) return { status: "ignored" };
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isValid(parsed)) return { status: "parsed", value: parsed };
      return { status: "malformed" };
    } catch {
      return { status: "malformed" };
    }
  });
}
