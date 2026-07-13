export type StreamSplitResult = {
  items: string[];
  rest: string;
};

export type StreamParseResult<T> = { status: "parsed"; value: T } | { status: "ignored" } | { status: "malformed" };

export class IncrementalStreamParser<T> {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly split: (buffer: string, allowEOF: boolean) => StreamSplitResult,
    private readonly parse: (item: string) => StreamParseResult<T>,
  ) {}

  feed(value: Uint8Array): { items: T[]; malformed: number } {
    this.buffer += this.decoder.decode(value, { stream: true });
    return this.consume(false);
  }

  flush(): { items: T[]; malformed: number } {
    this.buffer += this.decoder.decode();
    return this.consume(true);
  }

  getRemaining(): string {
    return this.buffer;
  }

  private consume(allowEOF: boolean): { items: T[]; malformed: number } {
    const split = this.split(this.buffer, allowEOF);
    this.buffer = split.rest;
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

export function splitSSEFrames(buffer: string, allowEOF: boolean): StreamSplitResult {
  const normalized = buffer.replaceAll("\r\n", "\n");
  const items: string[] = [];
  let cursor = 0;

  while (true) {
    const frameEnd = normalized.indexOf("\n\n", cursor);
    if (frameEnd === -1) break;
    items.push(normalized.slice(cursor, frameEnd));
    cursor = frameEnd + 2;
  }

  if (allowEOF && cursor < normalized.length) {
    items.push(normalized.slice(cursor));
    cursor = normalized.length;
  }

  return { items, rest: normalized.slice(cursor) };
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
