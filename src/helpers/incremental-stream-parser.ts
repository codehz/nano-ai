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
