/**
 * Responses Adapter
 *
 * 接入 OpenAI Responses API (responses 端点)。
 * 编排层：buildRequest + runStream（open → SSE 处理 → complete）。
 */

import { HttpAdapterBase } from "../../provider/http-adapter.js";
import { opaqueItem, replayFromOutput } from "../../canonical/index.js";
import { usageFromOpenAIResponses } from "../../provider/usage/index.js";
import { createSseJsonParser } from "../../provider/transport/parser.js";
import { buildResponsesRequest } from "./map-request.js";
import { inferResponsesStopReason } from "./infer-stop-reason.js";
import { createResponsesSseProcessor } from "./map-items.js";

import type { NormalizedRequest, AIStreamEvent } from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import type { ResponsesAdapterOptions, ResponsesAPIRequest, ResponsesSSEEvent } from "./types.js";

export class ResponsesAdapter extends HttpAdapterBase {
  readonly kind = "responses" as const;
  readonly isSyntheticStream = false;

  constructor(options: ResponsesAdapterOptions) {
    super(options, { baseUrl: "https://api.openai.com/v1" });
  }

  protected buildRequest(request: NormalizedRequest): ResponsesAPIRequest {
    return this.withExtraBody(buildResponsesRequest(request));
  }

  protected async *runStream(
    providerRequest: ResponsesAPIRequest,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    const session = this.beginJsonStream(factory, request);
    const { auxiliary } = session;

    await session.open({
      url: `${this.baseUrl}/responses`,
      headers: this.mergeHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      }),
      body: providerRequest,
    });

    const parser = createSseJsonParser<ResponsesSSEEvent>();
    const processor = createResponsesSseProcessor(factory);

    for await (const batch of session.batches({
      parser,
      providerLabel: "Responses",
      transportLabel: "SSE event(s)",
      incompleteMessage: "Stream ended with an incomplete Responses SSE frame",
    })) {
      for (const warning of batch.warnings) yield warning;
      for (const sseEvent of batch.items) {
        yield* processor.handleEvent(sseEvent);
      }
    }

    const completedResponse = processor.getCompletedResponse();
    let rawResponseId: string | undefined;
    if (completedResponse) {
      rawResponseId = completedResponse.id;
      if (completedResponse.usage) {
        auxiliary.recordUsage(usageFromOpenAIResponses(completedResponse.usage), "final", completedResponse.usage);
      }
    }

    const replay = [...replayFromOutput(processor.items.completedItems())];
    if (completedResponse?.id) {
      // 同时保留 id（向后兼容）与 previous_response_id（语义明确）
      replay.push(
        opaqueItem("responses", "replay", {
          id: completedResponse.id,
          previous_response_id: completedResponse.id,
        }),
      );
    }

    const stopReason = completedResponse ? inferResponsesStopReason(completedResponse) : undefined;

    yield* session.complete(
      {
        replay,
        stopReason,
        rawResponseId,
      },
      { onDuplicate: "silent" },
    );
  }
}
