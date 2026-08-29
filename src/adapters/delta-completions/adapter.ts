/**
 * DeltaCompletionsAdapter
 *
 * 残缺 OpenAI 兼容 SSE：只读 choices[0].delta.content，以流结束为完成。
 * 不要用本 adapter 对接完整 chat.completions。
 */

import { AIRequestError } from "../../runtime/errors.js";
import { HttpAdapterBase } from "../../provider/http-adapter.js";
import type { NormalizedRequest, AIStreamEvent } from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import type { DeltaCompletionsAdapterOptions, DeltaChatRequest } from "./types.js";
import { buildDeltaCompletionsRequest } from "./map-request.js";
import { mapDeltaCompletionsStream } from "./map-stream.js";

/** 残缺 chat/completions SSE 适配器。 */
export class DeltaCompletionsAdapter extends HttpAdapterBase {
  readonly kind = "delta-completions" as const;
  readonly isSyntheticStream = false;

  constructor(options: DeltaCompletionsAdapterOptions) {
    if (!options.baseUrl) {
      throw new AIRequestError(
        "DeltaCompletionsAdapter requires baseUrl; it does not default to the OpenAI API",
        "ADAPTER_OPTIONS_INVALID",
      );
    }
    super(options, { baseUrl: options.baseUrl });
  }

  protected buildRequest(request: NormalizedRequest): DeltaChatRequest {
    return this.withExtraBody(
      buildDeltaCompletionsRequest(request, { maxOpaquePayloadBytes: this.maxOpaquePayloadBytes }),
    );
  }

  protected async *runStream(
    providerRequest: DeltaChatRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    yield* mapDeltaCompletionsStream(
      {
        beginJsonStream: this.beginJsonStream.bind(this),
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        mergeHeaders: this.mergeHeaders.bind(this),
        maxOpaquePayloadBytes: this.maxOpaquePayloadBytes,
      },
      providerRequest,
      factory,
      request,
    );
  }
}
