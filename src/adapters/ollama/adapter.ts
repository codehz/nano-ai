/**
 * OllamaAdapter
 *
 * 编排层：buildRequest + runStream（委托 map-request / map-stream）。
 */

import { HttpAdapterBase } from "../../provider/http-adapter.js";
import type { NormalizedRequest, AIStreamEvent } from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import type { OllamaAdapterOptions, OllamaChatRequest } from "./types.js";
import { buildOllamaRequest } from "./map-request.js";
import { mapOllamaStream } from "./map-stream.js";

export class OllamaAdapter extends HttpAdapterBase {
  readonly kind = "ollama" as const;
  readonly isSyntheticStream = false;
  

  constructor(options: OllamaAdapterOptions = {}) {
    super(options, { baseUrl: "http://localhost:11434" });
  }

  protected buildRequest(request: NormalizedRequest): OllamaChatRequest {
    return this.withExtraBody(buildOllamaRequest(request));
  }

  protected async *runStream(
    providerRequest: OllamaChatRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    yield* mapOllamaStream(
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
