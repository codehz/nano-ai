/**
 * MessagesAdapter
 *
 * 编排层：buildRequest + runStream（委托 map-request / map-stream）。
 */

import { HttpAdapterBase } from "../../provider/http-adapter.js";
import type { NormalizedRequest, AIStreamEvent } from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import type { MessagesAdapterOptions, MessagesAPIRequest } from "./types.js";
import { buildMessagesRequest } from "./map-request.js";
import { mapMessagesStream } from "./map-stream.js";

export class MessagesAdapter extends HttpAdapterBase {
  readonly kind = "messages" as const;
  readonly isSyntheticStream = false;
  private apiVersion: string;

  constructor(options: MessagesAdapterOptions) {
    super(options, { baseUrl: "https://api.anthropic.com/v1" });
    this.apiVersion = options.apiVersion ?? "2023-06-01";
  }

  protected buildRequest(request: NormalizedRequest): MessagesAPIRequest {
    return this.withExtraBody(buildMessagesRequest(request));
  }

  protected async *runStream(
    providerRequest: MessagesAPIRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    yield* mapMessagesStream(
      {
        beginJsonStream: this.beginJsonStream.bind(this),
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        mergeHeaders: this.mergeHeaders.bind(this),
        apiVersion: this.apiVersion,
      },
      providerRequest,
      factory,
      request,
    );
  }
}
