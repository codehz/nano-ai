/**
 * ChatCompletionsAdapter
 *
 * 编排层：buildRequest + runStream（委托 map-request / map-stream）。
 */

import { HttpAdapterBase } from "../../provider/http-adapter.js";
import type { NormalizedRequest, AIStreamEvent } from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import type { ChatCompletionsAdapterOptions, ChatRequest } from "./types.js";
import { buildChatCompletionsRequest } from "./map-request.js";
import { mapChatCompletionsStream } from "./map-stream.js";

export class ChatCompletionsAdapter extends HttpAdapterBase {
  readonly kind = "chat-completions" as const;
  readonly isSyntheticStream = false;
  

  constructor(options: ChatCompletionsAdapterOptions) {
    super(options, { baseUrl: "https://api.openai.com/v1" });
  }

  protected buildRequest(request: NormalizedRequest): ChatRequest {
    return this.withExtraBody(buildChatCompletionsRequest(request));
  }

  protected async *runStream(
    providerRequest: ChatRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    yield* mapChatCompletionsStream(
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
