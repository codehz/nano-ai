/**
 * GeminiAdapter
 *
 * 编排层：buildRequest + runStream（委托 map-request / map-stream）。
 */

import { HttpAdapterBase } from "../../provider/http-adapter.js";
import type { NormalizedRequest, AIStreamEvent } from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import type { GeminiAdapterOptions, GeminiGenerateContentRequest } from "./types.js";
import { buildGeminiRequest } from "./map-request.js";
import { mapGeminiStream } from "./map-stream.js";

export class GeminiAdapter extends HttpAdapterBase {
  readonly kind = "gemini" as const;
  readonly isSyntheticStream = false;
  

  constructor(options: GeminiAdapterOptions) {
    super(options, { baseUrl: "https://generativelanguage.googleapis.com/v1beta" });
  }

  protected buildRequest(request: NormalizedRequest): GeminiGenerateContentRequest {
    return this.withExtraBody(buildGeminiRequest(request));
  }

  protected async *runStream(
    providerRequest: GeminiGenerateContentRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    yield* mapGeminiStream(
      {
        beginJsonStream: this.beginJsonStream.bind(this),
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        mergeHeaders: this.mergeHeaders.bind(this),
        
      },
      providerRequest,
      factory,
      request,
    );
  }
}
