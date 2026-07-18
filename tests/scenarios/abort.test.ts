/**
 * AbortSignal 测试
 *
 * 验证：
 * - 提前 abort 不产生任何事件
 * - 中途 abort 事件流截断
 * - client 级别 signal 与请求级别 signal 合并
 * - MockHandlerContext 可感知 signal
 */

import { describe, expect, it } from "bun:test";

import { MockAdapter, createAIClient, textBlock, withMockStreaming } from "../../src/index.js";
// ── 辅助：收集所有事件直到迭代器结束或 reject ────────────────

async function collectAllEvents(
  stream: AsyncIterable<import("../../src/index.js").AIStreamEvent>,
): Promise<import("../../src/index.js").AIStreamEvent[]> {
  const events: import("../../src/index.js").AIStreamEvent[] = [];
  try {
    for await (const event of stream) {
      events.push(event);
    }
  } catch (err) {
    // AbortError 会终止迭代
    if (err instanceof DOMException && err.name === "AbortError") {
      return events;
    }
    throw err;
  }
  return events;
}

// ── 测试 ──────────────────────────────────────────────────────

describe("AbortSignal", () => {
  it("should not emit any events when signal is already aborted", async () => {
    const adapter = new MockAdapter({
      handler: async function* () {
        yield { type: "message", content: "should not be reached" };
      },
    });

    const controller = new AbortController();
    controller.abort(); // 提前 abort

    const events = await collectAllEvents(
      adapter.stream({
        model: "mock-model",
        requestId: "abort-1",
        signal: controller.signal,
        input: [{ type: "message", role: "user", content: [textBlock("hi")] }],
      }),
    );

    expect(events).toHaveLength(0);
  });

  it("should stop the stream when signaled mid-stream", async () => {
    const controller = new AbortController();

    const adapter = new MockAdapter({
      handler: withMockStreaming(
        async function* () {
          yield { type: "message", content: "Hello" };
          // 下一句不应该到达，因为 signal 会在第一个消息后 abort
          yield { type: "message", content: "should not appear" };
        },
        { chunkSize: 1, charsPerSecond: 10, initialDelayMs: 0 },
      ),
    });

    const stream = adapter.stream({
      model: "mock-model",
      requestId: "abort-2",
      signal: controller.signal,
      input: [{ type: "message", role: "user", content: [textBlock("hi")] }],
    });

    const events: typeof stream extends AsyncIterable<infer E> ? E[] : never[] = [];

    // 手动迭代，在第一个 message.delta 后 abort
    const iter = stream[Symbol.asyncIterator]();
    const first = await iter.next();
    if (!first.done) events.push(first.value as (typeof events)[0]);

    if (first.value && (first.value as { type: string }).type === "response.started") {
      const second = await iter.next();
      if (!second.done) {
        events.push(second.value as (typeof events)[0]);
        // 收到第一个 message 相关事件后立即 abort
        controller.abort();
      }
    }

    // 继续消费剩余事件
    try {
      let next = await iter.next();
      while (!next.done) {
        events.push(next.value as (typeof events)[0]);
        next = await iter.next();
      }
    } catch {
      // abort 后 reader 可能抛错
    }

    // 关键断言：不应有 response.completed
    const hasCompleted = events.some((e) => e.type === "response.completed");
    expect(hasCompleted).toBeFalse();
  });

  it("should merge client-level and request-level signals", async () => {
    const clientController = new AbortController();
    const requestController = new AbortController();

    const adapter = new MockAdapter({
      handler: async function* () {
        yield { type: "message", content: "not reached" };
      },
    });

    const client = createAIClient({
      adapter,
      model: "mock-model",
      signal: clientController.signal,
    });

    // 只 abort 请求级 signal，client 级未 abort
    requestController.abort();

    const events = await collectAllEvents(
      client.stream({
        signal: requestController.signal,
        input: [{ type: "message", role: "user", content: [textBlock("hi")] }],
      }),
    );

    expect(events).toHaveLength(0);
  });

  it("should NOT abort when client-level signal is NOT aborted and request has no signal", async () => {
    const clientController = new AbortController();

    const adapter = new MockAdapter({
      handler: async function* () {
        yield { type: "message", content: "normal" };
      },
    });

    const client = createAIClient({
      adapter,
      model: "mock-model",
      signal: clientController.signal,
    });

    // client.signal 未 abort，request 也没有自己的 signal
    const events = await collectAllEvents(
      client.stream({
        input: [{ type: "message", role: "user", content: [textBlock("hi")] }],
      }),
    );

    expect(events.some((e) => e.type === "response.started")).toBeTrue();
    expect(events.some((e) => e.type === "response.completed")).toBeTrue();
  });

  it("should expose signal in MockHandlerContext", async () => {
    let capturedSignal: AbortSignal | undefined;

    const adapter = new MockAdapter({
      handler: async function* (_request, context) {
        capturedSignal = context.signal;
        yield { type: "message", content: "ok" };
      },
    });

    const controller = new AbortController();

    await collectAllEvents(
      adapter.stream({
        model: "mock-model",
        requestId: "abort-ctx",
        signal: controller.signal,
        input: [{ type: "message", role: "user", content: [textBlock("hi")] }],
      }),
    );

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBeFalse();

    controller.abort();
    expect(capturedSignal?.aborted).toBeTrue();
  });

  it("should abort via client signal when request has no signal", async () => {
    const clientController = new AbortController();

    const adapter = new MockAdapter({
      handler: async function* () {
        yield { type: "message", content: "not reached" };
      },
    });

    const client = createAIClient({
      adapter,
      model: "mock-model",
      signal: clientController.signal,
    });

    clientController.abort();

    const events = await collectAllEvents(
      client.stream({
        input: [{ type: "message", role: "user", content: [textBlock("hi")] }],
      }),
    );

    expect(events).toHaveLength(0);
  });

  it("should abort via client-level signal when both signals set but request signal not aborted", async () => {
    const clientController = new AbortController();
    const requestController = new AbortController();

    const adapter = new MockAdapter({
      handler: async function* () {
        yield { type: "message", content: "not reached" };
      },
    });

    const client = createAIClient({
      adapter,
      model: "mock-model",
      signal: clientController.signal,
    });

    // abort client 级别，请求级未 abort
    clientController.abort();

    const events = await collectAllEvents(
      client.stream({
        signal: requestController.signal,
        input: [{ type: "message", role: "user", content: [textBlock("hi")] }],
      }),
    );

    expect(events).toHaveLength(0);
  });
});
