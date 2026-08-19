/**
 * Responses Adapter
 *
 * 接入 OpenAI Responses API (responses 端点)。
 * 编排层：buildRequest + runStream（open → SSE 处理 → complete）。
 * 可选能力：compress → POST /responses/compact（ContextCompressCapable）。
 */

import { HttpAdapterBase } from "../../provider/http-adapter.js";
import { opaqueItem } from "../../canonical/index.js";
import { usageFromOpenAIResponses } from "../../provider/usage/index.js";
import { createSseJsonParser } from "../../provider/transport/parser.js";
import { postProviderJson } from "../../provider/transport/open-stream.js";
import { finalizeStreamTurn } from "../../provider/finalize-stream-turn.js";
import { OPAQUE_SOURCE } from "../../provider/opaque-sources.js";
import { assertOpaqueReplayEnvelope } from "../../provider/security.js";
import { AIStreamError } from "../../runtime/errors.js";
import { buildResponsesCompactRequest, buildResponsesRequest, RESPONSES_COMPACTED_WINDOW_KIND } from "./map-request.js";
import { inferResponsesStopReason } from "./infer-stop-reason.js";
import { createResponsesSseProcessor } from "./map-items.js";

import type {
  AIStreamEvent,
  CompressRequest,
  CompressResult,
  ContextCompressCapable,
  NormalizedRequest,
} from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import type {
  ResponsesAdapterOptions,
  ResponsesAPIRequest,
  ResponsesCompactAPIResponse,
  ResponsesSSEEvent,
} from "./types.js";

export class ResponsesAdapter extends HttpAdapterBase implements ContextCompressCapable {
  readonly kind = "responses" as const;
  readonly isSyntheticStream = false;

  constructor(options: ResponsesAdapterOptions) {
    super(options, { baseUrl: "https://api.openai.com/v1" });
  }

  protected buildRequest(request: NormalizedRequest): ResponsesAPIRequest {
    return this.withExtraBody(buildResponsesRequest(request, { maxOpaquePayloadBytes: this.maxOpaquePayloadBytes }));
  }

  /**
   * 原生上下文压缩：POST /responses/compact。
   * 结果以单个 opaque(kind=compacted_window) 回传；调用方用 replay 替换旧 transcript。
   */
  async compress(request: CompressRequest): Promise<CompressResult> {
    request.signal?.throwIfAborted();

    const body = this.withExtraBody(
      buildResponsesCompactRequest(request, { maxOpaquePayloadBytes: this.maxOpaquePayloadBytes }),
    );
    const { data } = await postProviderJson<ResponsesCompactAPIResponse>({
      fetchFn: this.fetchFn,
      url: `${this.baseUrl}/responses/compact`,
      headers: this.mergeHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      }),
      body,
      signal: request.signal,
    });

    if (!data || typeof data !== "object" || !Array.isArray(data.output)) {
      throw new AIStreamError("Responses compact response missing output array", "STREAM_PROTOCOL_ERROR");
    }

    const payload: Record<string, unknown> = {
      kind: RESPONSES_COMPACTED_WINDOW_KIND,
      output: data.output,
    };
    if (typeof data.id === "string" && data.id.length > 0 && data.id.length <= 256) {
      payload.id = data.id;
    }

    // compress 无 warning 通道：超限硬失败，避免写出不可回放的 window
    assertOpaqueReplayEnvelope(payload, { maxBytes: this.maxOpaquePayloadBytes });

    const result: CompressResult = {
      replay: [opaqueItem(OPAQUE_SOURCE.RESPONSES, "replay", payload)],
    };

    if (data.usage) {
      const usage = usageFromOpenAIResponses(data.usage);
      if (Object.keys(usage).length > 0) {
        result.usage = usage;
      }
      if (request.include?.usage === "best_effort" || request.include?.providerMetadata === "best_effort") {
        result.auxiliary = {
          usageSource: "final",
          providerUsage: data.usage,
        };
      }
    }

    if (typeof data.id === "string" && data.id.length > 0) {
      result.rawResponseId = data.id;
    }

    return result;
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

    const stopReason = completedResponse ? inferResponsesStopReason(completedResponse) : undefined;
    yield* finalizeStreamTurn(session, processor.items, {
      // 同时保留 id（向后兼容）与 previous_response_id（语义明确）
      opaque: completedResponse?.id
        ? opaqueItem(OPAQUE_SOURCE.RESPONSES, "replay", {
            id: completedResponse.id,
            previous_response_id: completedResponse.id,
          })
        : null,
      stopReason,
      rawResponseId,
      factory,
      maxOpaquePayloadBytes: this.maxOpaquePayloadBytes,
      onDuplicate: "silent",
    });
  }
}
