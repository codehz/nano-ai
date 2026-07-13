/**
 * Provider HTTP 流公共脚手架
 *
 * 收敛 adapter 间重复的：
 * - JSON POST + 错误映射
 * - ReadableStream reader 生命周期
 * - IncrementalStreamParser feed/flush + malformed warning
 * - 不完整尾帧 warning
 */

import { AIProviderError, AIStreamError } from "../core/errors.js";
import type { EventFactory } from "../core/event-factory.js";
import type { AIStreamEvent, FetchFn } from "../types/index.js";
import { emitMalformedStreamWarning } from "./adapter-auxiliary.js";
import { providerHttpError } from "./adapter-security.js";
import type { IncrementalStreamParser } from "./incremental-stream-parser.js";

export type OpenProviderJsonStreamOptions = {
  fetchFn: FetchFn;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
};

export type OpenedProviderStream = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  headers: Headers;
};

/** POST JSON 并返回可读 body reader + response headers；统一网络/HTTP/空 body 错误。 */
export async function openProviderJsonStream(options: OpenProviderJsonStreamOptions): Promise<OpenedProviderStream> {
  const { fetchFn, url, headers, body, signal } = options;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new AIProviderError(err instanceof Error ? err.message : String(err), "PROVIDER_ERROR");
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw providerHttpError(response.status, errorBody);
  }

  const bodyStream = response.body;
  if (!bodyStream) {
    throw new AIStreamError("Response body is not readable", "STREAM_ERROR");
  }

  // Bun/DOM ReadableStreamDefaultReader 类型略有差异，按最小接口使用
  return {
    reader: bodyStream.getReader() as ReadableStreamDefaultReader<Uint8Array>,
    headers: response.headers,
  };
}

export type ProviderStreamBatchOptions<T> = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  parser: IncrementalStreamParser<T>;
  factory: EventFactory;
  providerLabel: string;
  transportLabel: string;
  incompleteMessage: string;
};

export type ProviderStreamBatch<T> = {
  items: T[];
  warnings: AIStreamEvent[];
};

/**
 * 读取并解析 provider 流。
 * 每个 batch 携带本轮解析出的 items 与（可选）malformed / incomplete warning。
 * 调用方应 `for await` 消费完毕；reader 在迭代结束时 cancel/release。
 */
export async function* iterateProviderStreamBatches<T>(
  options: ProviderStreamBatchOptions<T>,
): AsyncGenerator<ProviderStreamBatch<T>, void, undefined> {
  const { reader, parser, factory, providerLabel, transportLabel, incompleteMessage } = options;
  let streamDone = false;

  try {
    while (true) {
      const readResult = await reader.read().catch((err: unknown) => {
        throw new AIStreamError(
          `Failed to read response stream: ${err instanceof Error ? err.message : String(err)}`,
          "STREAM_ERROR",
        );
      });
      const { done, value } = readResult;
      const { items, malformed } = done ? parser.flush() : parser.feed(value as Uint8Array);

      const warnings: AIStreamEvent[] = [];
      const malformedWarning = emitMalformedStreamWarning(factory, {
        count: malformed,
        providerLabel,
        transportLabel,
      });
      if (malformedWarning) warnings.push(malformedWarning);

      yield { items, warnings };

      if (done) {
        streamDone = true;
        break;
      }
    }
  } finally {
    try {
      if (!streamDone) await reader.cancel().catch(() => undefined);
    } finally {
      reader.releaseLock();
    }
  }

  if (parser.getRemaining().trim().length > 0) {
    yield {
      items: [],
      warnings: [factory.responseWarning(incompleteMessage, "STREAM_ERROR")],
    };
  }
}

/** 一次性 complete 守卫：首次成功，后续返回 false。 */
export function createCompletionGate(): {
  readonly completed: boolean;
  tryComplete(): boolean;
} {
  let completed = false;
  return {
    get completed() {
      return completed;
    },
    tryComplete() {
      if (completed) return false;
      completed = true;
      return true;
    },
  };
}
