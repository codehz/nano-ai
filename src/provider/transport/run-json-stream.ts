/**
 * Provider JSON 流 session
 *
 * 收敛 HTTP adapter 的 open → iterate → complete 脚手架。
 * **不**在 batches 结束后自动 complete（chat/gemini/ollama 需中途 complete）。
 *
 * 错误路径仍只在 open-stream 映射：HTTP 非 2xx / 网络 / malformed / incomplete frame。
 */

import { AIStreamError, WarningCode } from "../../runtime/errors.js";
import type { EventFactory } from "../../stream/event-factory.js";
import type { AIStreamEvent, FetchFn, NormalizedRequest } from "../../types/index.js";
import type { AdapterAuxiliaryState } from "../auxiliary.js";
import type { StreamResult } from "../base.js";
import {
  createCompletionGate,
  iterateProviderStreamBatches,
  openProviderJsonStream,
  type ProviderStreamBatch,
} from "./open-stream.js";
import type { IncrementalStreamParser } from "./parser.js";

export type ProviderJsonStreamSessionHost = {
  fetchFn: FetchFn;
  factory: EventFactory;
  request: NormalizedRequest;
  auxiliary: AdapterAuxiliaryState;
  emitCompleted: (auxiliary: AdapterAuxiliaryState, result: StreamResult) => AsyncIterable<AIStreamEvent>;
};

export type ProviderJsonStreamOpenOptions = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

export type ProviderJsonStreamBatchOptions<T> = {
  parser: IncrementalStreamParser<T>;
  providerLabel: string;
  transportLabel: string;
  incompleteMessage: string;
};

export type ProviderJsonStreamCompleteOptions = {
  /**
   * 重复 complete 时：`warn` 发 DUPLICATE_FINISH（默认，对齐 chat/gemini/ollama）；
   * `silent` 静默忽略（messages/responses 历史路径几乎不会触发）。
   */
  onDuplicate?: "warn" | "silent";
};

export type ProviderJsonStreamSession = {
  readonly auxiliary: AdapterAuxiliaryState;
  readonly gate: {
    readonly completed: boolean;
    tryComplete(): boolean;
  };
  /** open 成功后填充的 response headers */
  readonly headers: Headers | undefined;
  open(options: ProviderJsonStreamOpenOptions): Promise<{ headers: Headers }>;
  batches<T>(options: ProviderJsonStreamBatchOptions<T>): AsyncGenerator<ProviderStreamBatch<T>, void, undefined>;
  complete(result: StreamResult, options?: ProviderJsonStreamCompleteOptions): AsyncIterable<AIStreamEvent>;
};

/**
 * 创建 JSON provider 流 session。
 * 调用方负责：鉴权 headers、parser、业务 map、何时 complete。
 */
export function createProviderJsonStreamSession(host: ProviderJsonStreamSessionHost): ProviderJsonStreamSession {
  const gate = createCompletionGate();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let responseHeaders: Headers | undefined;
  let opened = false;

  return {
    get auxiliary() {
      return host.auxiliary;
    },
    get gate() {
      return gate;
    },
    get headers() {
      return responseHeaders;
    },

    async open(options) {
      if (opened) {
        throw new AIStreamError("Provider JSON stream already opened", "STREAM_ERROR");
      }
      const openedStream = await openProviderJsonStream({
        fetchFn: host.fetchFn,
        url: options.url,
        headers: options.headers,
        body: options.body,
        signal: host.request.signal,
      });
      reader = openedStream.reader;
      responseHeaders = openedStream.headers;
      opened = true;
      return { headers: openedStream.headers };
    },

    batches(options) {
      if (!reader) {
        throw new AIStreamError("Provider JSON stream is not open", "STREAM_ERROR");
      }
      return iterateProviderStreamBatches({
        reader,
        parser: options.parser,
        factory: host.factory,
        providerLabel: options.providerLabel,
        transportLabel: options.transportLabel,
        incompleteMessage: options.incompleteMessage,
      });
    },

    async *complete(result, options) {
      if (!gate.tryComplete()) {
        if (options?.onDuplicate !== "silent") {
          yield host.factory.responseWarning("Duplicate finish signal ignored", WarningCode.DUPLICATE_FINISH);
        }
        return;
      }
      yield* host.emitCompleted(host.auxiliary, result);
    },
  };
}
