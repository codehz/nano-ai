/**
 * Mock Adapter
 *
 * 面向测试的回调驱动 adapter：
 * - 每次请求执行用户提供的 handler
 * - 验证调用方是否正确续接 replay / tool_result
 * - 发出可控的 message / reasoning / tool_call 流
 * - 注入 warning / auxiliary / content_filter / 中断 / provider error
 *
 * 这不是通用“假模型”，而是测试工具调用编排与错误路径的测试夹具。
 */

import { AIRequestError } from "../../runtime/errors.js";
import { AdapterBase } from "../../provider/base.js";
import { replayFromOutput } from "../../canonical/index.js";
import type {
  AIStreamEvent,
  NormalizedRequest,
  OutputItem,
  ReplayItem,
  ToolCallItem,
  ToolResultItem,
  InputItem,
  StopReason,
} from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import type {
  MockAdapterOptions,
  MockCompleteStep,
  MockHandler,
  MockHandlerContext,
  MockHistoryRecord,
  MockProviderRequest,
} from "./types.js";
import {
  attachSyntheticId,
  assertSupportedOutputItem,
  createMessageFromStep,
  createReasoningFromStep,
  createServerToolCallFromStep,
  createToolCallFromStep,
  emitMessage,
  emitOutputItem,
  emitReasoning,
  emitServerToolCall,
  emitToolCall,
  resolveStepStreamOptions,
} from "./streaming.js";

export class MockAdapter extends AdapterBase {
  readonly kind = "mock" as const;
  readonly isSyntheticStream = true;

  private readonly handler: MockHandler;
  private readonly providerMetadata?: Record<string, unknown>;

  private cursor = 0;
  private previousReplay: ReplayItem[] = [];
  private pendingToolCalls: ToolCallItem[] = [];
  private history: MockHistoryRecord[] = [];
  private activeStream = false;

  constructor(options: MockAdapterOptions) {
    super();
    this.handler = options.handler;
    this.providerMetadata = options.providerMetadata;
  }

  protected async buildRequest(request: NormalizedRequest): Promise<MockProviderRequest> {
    const turnIndex = this.cursor;
    const context = this.buildHandlerContext(turnIndex, request);
    const remainingPendingToolCalls = consumePendingToolCalls(this.pendingToolCalls, request.input);
    const handlerResult = this.handler(request, context);

    this.cursor += 1;

    return {
      request,
      handlerResult,
      turnIndex,
      remainingPendingToolCalls,
    };
  }

  protected async *runStream(
    providerRequest: unknown,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent> {
    if (this.activeStream) {
      throw new AIRequestError("MockAdapter does not support concurrent streams", "MOCK_CONCURRENT_STREAM");
    }

    this.activeStream = true;

    try {
      const mockRequest = providerRequest as MockProviderRequest;
      const output: OutputItem[] = [];
      let stepCount = 0;

      for await (const step of mockRequest.handlerResult) {
        // 若 signal 已 abort，停止消费 handler 并返回
        if (request.signal?.aborted) return;

        stepCount += 1;

        switch (step.type) {
          case "warning":
            yield factory.responseWarning(step.message, step.code);
            break;
          case "auxiliary":
            yield factory.responseAuxiliary({
              usage: step.usage,
              billing: step.billing,
              auxiliary: step.auxiliary,
            });
            break;
          case "message": {
            const item = createMessageFromStep(step, request, mockRequest.turnIndex, stepCount - 1);
            yield* emitMessage(factory, item, resolveStepStreamOptions(undefined, step.stream, "message"));
            output.push(item);
            break;
          }
          case "reasoning": {
            const item = createReasoningFromStep(step, request, mockRequest.turnIndex, stepCount - 1);
            yield* emitReasoning(factory, item, resolveStepStreamOptions(undefined, step.stream, "reasoning"));
            output.push(item);
            break;
          }
          case "tool_call": {
            const item = createToolCallFromStep(step);
            yield* emitToolCall(
              factory,
              item,
              step.streamArguments ?? true,
              resolveStepStreamOptions(undefined, step.stream, "tool_call"),
            );
            output.push(item);
            break;
          }
          case "server_tool_call": {
            const item = createServerToolCallFromStep(step);
            yield* emitServerToolCall(
              factory,
              item,
              step.streamArguments ?? true,
              resolveStepStreamOptions(undefined, step.stream, "server_tool_call"),
            );
            output.push(item);
            break;
          }
          case "server_tool_result": {
            yield factory.serverToolResultCompleted(step.item);
            output.push(step.item);
            break;
          }
          case "server_tool_discovery": {
            yield factory.serverToolDiscoveryCompleted(step.item);
            output.push(step.item);
            break;
          }
          case "output": {
            assertSupportedOutputItem(step.item);
            const item = attachSyntheticId(step.item, request, mockRequest.turnIndex, stepCount - 1);
            yield* emitOutputItem(factory, item, resolveStepStreamOptions(undefined, step.stream, "output"));
            output.push(item);
            break;
          }
          case "complete": {
            const finalResponse = this.finalizeTurn(request, factory, mockRequest, output, step, stepCount);
            yield factory.responseCompleted({
              replay: finalResponse.replay,
              stopReason: finalResponse.stopReason,
              trace: finalResponse.backend,
              usage: finalResponse.usage,
              billing: finalResponse.billing,
              auxiliary: finalResponse.auxiliary,
              warnings: finalResponse.warnings,
            });
            return;
          }
          case "error": {
            yield factory.responseWarning(step.message, step.code);
            const finalResponse = this.finalizeTurn(
              request,
              factory,
              mockRequest,
              output,
              {
                type: "complete",
                stopReason: step.stopReason ?? "error",
                providerMetadata: step.providerMetadata,
              },
              stepCount,
            );
            yield factory.responseCompleted({
              replay: finalResponse.replay,
              stopReason: finalResponse.stopReason,
              trace: finalResponse.backend,
              usage: finalResponse.usage,
              billing: finalResponse.billing,
              auxiliary: finalResponse.auxiliary,
              warnings: finalResponse.warnings,
            });
            return;
          }
          case "interrupt":
            this.pendingToolCalls = mockRequest.remainingPendingToolCalls;
            return;
          case "throw":
            throw typeof step.error === "string" ? new Error(step.error) : step.error;
        }
      }

      const finalResponse = this.finalizeTurn(
        request,
        factory,
        mockRequest,
        output,
        {
          type: "complete",
        },
        stepCount,
      );
      yield factory.responseCompleted({
        replay: finalResponse.replay,
        stopReason: finalResponse.stopReason,
        trace: finalResponse.backend,
        usage: finalResponse.usage,
        billing: finalResponse.billing,
        auxiliary: finalResponse.auxiliary,
        warnings: finalResponse.warnings,
      });
    } finally {
      this.activeStream = false;
    }
  }

  private finalizeTurn(
    request: NormalizedRequest,
    factory: EventFactory,
    mockRequest: MockProviderRequest,
    output: OutputItem[],
    completion: MockCompleteStep,
    stepCount: number,
  ) {
    const replay = completion.replay ?? replayFromOutput(output);
    const toolCalls = output.filter((item): item is ToolCallItem => item.type === "tool_call");

    this.previousReplay = replay;
    this.pendingToolCalls = [...mockRequest.remainingPendingToolCalls, ...toolCalls];
    this.history.push({
      turnIndex: mockRequest.turnIndex,
      requestId: request.requestId,
      replay,
      toolCalls,
    });

    return this.buildResponse(
      request,
      {
        output,
        replay,
        stopReason: completion.stopReason ?? resolveStopReason(output),
        usage: completion.usage,
        billing: completion.billing,
        auxiliary: completion.auxiliary,
        providerMetadata: {
          turnIndex: mockRequest.turnIndex,
          stepCount,
          pendingToolCallIds: this.pendingToolCalls.map((item) => item.id),
          historyLength: this.history.length,
          ...this.providerMetadata,
          ...completion.providerMetadata,
        },
        warnings: completion.warnings,
        metadataSources: ["mock"],
        rawResponseId: completion.rawResponseId,
      },
      factory,
    );
  }

  private buildHandlerContext(turnIndex: number, request: NormalizedRequest): MockHandlerContext {
    return {
      turnIndex,
      previousReplay: this.previousReplay.map(cloneItem),
      pendingToolCalls: this.pendingToolCalls.map(cloneItem),
      history: this.history.map((record) => ({
        ...record,
        replay: record.replay.map(cloneItem),
        toolCalls: record.toolCalls.map(cloneItem),
      })),
      signal: request.signal,
      reasoningLevel: request.reasoningLevel,
    };
  }
}

function resolveStopReason(output: OutputItem[]): StopReason {
  return output.some((item) => item.type === "tool_call") ? "tool_call" : "end_turn";
}

function consumePendingToolCalls(pending: readonly ToolCallItem[], input: readonly InputItem[]): ToolCallItem[] {
  const fulfilledIds = new Set(
    input.filter((item): item is ToolResultItem => item.type === "tool_result").map((item) => item.callId),
  );

  return pending.filter((item) => !fulfilledIds.has(item.id)).map(cloneItem);
}

function cloneItem<T>(item: T): T {
  return structuredClone(item);
}
