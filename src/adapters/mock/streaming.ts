/**
 * Mock 流式包装与事件发射
 */

import { AIRequestError } from "../../runtime/errors.js";
import { messageItem, reasoningItem, serverToolCallItem, textBlock } from "../../canonical/index.js";
import type {
  AIStreamEvent,
  ContentBlock,
  MessageItem,
  NormalizedRequest,
  OutputItem,
  ServerToolCallItem,
  ToolCallItem,
} from "../../types/index.js";
import type { EventFactory } from "../../stream/event-factory.js";
import type {
  MockHandler,
  MockHandlerContext,
  MockMessageStep,
  MockReasoningStep,
  MockServerToolCallStep,
  MockStaticHandler,
  MockStep,
  MockTextStreamOptions,
  MockToolCallStep,
  ResolvedMockTextStreamOptions,
} from "./types.js";

export function withMockStreaming(handler: MockStaticHandler, options: MockTextStreamOptions): MockHandler {
  const defaults = resolveMockTextStreamOptions(options, "mock stream wrapper");
  if (!defaults) {
    throw new AIRequestError("mock stream wrapper requires streaming options", "MOCK_STREAM_CONFIG_INVALID");
  }

  return async function* streamWrappedHandler(
    request: NormalizedRequest,
    context: MockHandlerContext,
  ): AsyncIterable<MockStep> {
    const source = await handler(request, context);

    for await (const step of source) {
      yield applyDefaultStreaming(step, defaults);
    }
  };
}

export function applyDefaultStreaming(step: MockStep, defaults: ResolvedMockTextStreamOptions): MockStep {
  switch (step.type) {
    case "message":
    case "reasoning":
    case "tool_call":
    case "server_tool_call":
    case "output":
      if (step.stream !== undefined) {
        return step;
      }
      return {
        ...step,
        stream: {
          charsPerSecond: defaults.charsPerSecond,
          chunkSize: defaults.chunkSize,
          initialDelayMs: defaults.initialDelayMs,
        },
      };
    default:
      return step;
  }
}

export function createMessageFromStep(
  step: MockMessageStep,
  request: NormalizedRequest,
  turnIndex: number,
  stepIndex: number,
): MessageItem {
  return {
    ...messageItem(normalizeBlocks(step.content), {
      id: step.id ?? `mock-msg-${request.requestId}-${turnIndex}-${stepIndex}`,
      ...(step.citations ? { citations: step.citations } : {}),
    }),
    role: "assistant",
  };
}

export function createReasoningFromStep(
  step: MockReasoningStep,
  request: NormalizedRequest,
  turnIndex: number,
  stepIndex: number,
): Extract<OutputItem, { type: "reasoning" }> {
  return reasoningItem(
    normalizeBlocks(step.content),
    step.visibility ?? "full",
    step.id ?? `mock-reason-${request.requestId}-${turnIndex}-${stepIndex}`,
  );
}

export function createToolCallFromStep(step: MockToolCallStep): ToolCallItem {
  return {
    type: "tool_call",
    id: step.id,
    name: step.name,
    argumentsText: step.argumentsText,
  };
}

export function createServerToolCallFromStep(step: MockServerToolCallStep): ServerToolCallItem {
  return serverToolCallItem(step.id, step.tool, {
    name: step.name,
    argumentsText: step.argumentsText,
    serverLabel: step.serverLabel,
    status: step.status ?? "completed",
    providerPayload: step.providerPayload,
  });
}

export function normalizeBlocks(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === "string" ? [textBlock(content)] : content;
}

export function assertSupportedOutputItem(item: OutputItem): void {
  if (item.type === "opaque") {
    throw new AIRequestError(
      "MockAdapter does not stream opaque output items; use complete.replay if needed",
      "MOCK_OPAQUE_OUTPUT",
    );
  }
}

export function attachSyntheticId(
  item: Extract<OutputItem, { type: "message" | "reasoning" | "tool_call" }>,
  request: NormalizedRequest,
  turnIndex: number,
  stepIndex: number,
): Extract<OutputItem, { type: "message" | "reasoning" | "tool_call" }> {
  if (item.type === "message") {
    return {
      ...item,
      id: item.id ?? `mock-msg-${request.requestId}-${turnIndex}-${stepIndex}`,
      role: "assistant",
    };
  }

  if (item.type === "reasoning") {
    return {
      ...item,
      id: item.id ?? `mock-reason-${request.requestId}-${turnIndex}-${stepIndex}`,
    };
  }

  return item;
}

export async function* emitOutputItem(
  factory: EventFactory,
  item: Extract<OutputItem, { type: "message" | "reasoning" | "tool_call" }>,
  stream?: ResolvedMockTextStreamOptions,
): AsyncIterable<AIStreamEvent> {
  if (item.type === "message") {
    yield* emitMessage(factory, item, stream);
    return;
  }

  if (item.type === "reasoning") {
    yield* emitReasoning(factory, item, stream);
    return;
  }

  yield* emitToolCall(factory, item, true, stream);
}

export async function* emitMessage(
  factory: EventFactory,
  item: MessageItem,
  stream?: ResolvedMockTextStreamOptions,
): AsyncIterable<AIStreamEvent> {
  if (!item.id) {
    throw new AIRequestError("Mock message output requires an id after normalization", "MOCK_MESSAGE_ID_MISSING");
  }

  yield factory.messageStarted(item.id);

  let chunkIndex = 0;
  for (const block of item.content) {
    if (block.type === "text") {
      for (const chunk of chunkText(block.text, stream)) {
        await delayForChunk(stream, chunkIndex, chunk.length);
        yield factory.messageDelta(item.id, textBlock(chunk));
        chunkIndex += 1;
      }
    } else {
      yield factory.messageDelta(item.id, block);
    }
  }

  yield factory.messageCompleted(item.id, item.citations ? { citations: item.citations } : undefined);
}

export async function* emitReasoning(
  factory: EventFactory,
  item: Extract<OutputItem, { type: "reasoning" }>,
  stream?: ResolvedMockTextStreamOptions,
): AsyncIterable<AIStreamEvent> {
  if (!item.id) {
    throw new AIRequestError("Mock reasoning output requires an id after normalization", "MOCK_REASONING_ID_MISSING");
  }

  yield factory.reasoningStarted(item.id, item.visibility);

  let chunkIndex = 0;
  for (const block of item.content) {
    if (block.type !== "text") {
      yield factory.reasoningDelta(item.id, block);
      continue;
    }

    for (const chunk of chunkText(block.text, stream)) {
      await delayForChunk(stream, chunkIndex, chunk.length);
      yield factory.reasoningDelta(item.id, textBlock(chunk));
      chunkIndex += 1;
    }
  }

  yield factory.reasoningCompleted(item.id);
}

export async function* emitToolCall(
  factory: EventFactory,
  item: ToolCallItem,
  streamArguments: boolean,
  stream?: ResolvedMockTextStreamOptions,
): AsyncIterable<AIStreamEvent> {
  yield factory.toolCallStarted(item.id, item.name);

  if (streamArguments && item.argumentsText) {
    let chunkIndex = 0;
    for (const chunk of chunkText(item.argumentsText, stream)) {
      await delayForChunk(stream, chunkIndex, chunk.length);
      yield factory.toolCallDelta(item.id, { argumentsText: chunk });
      chunkIndex += 1;
    }
  }

  yield factory.toolCallCompleted(item.id);
}

export async function* emitServerToolCall(
  factory: EventFactory,
  item: ServerToolCallItem,
  streamArguments: boolean,
  stream?: ResolvedMockTextStreamOptions,
): AsyncIterable<AIStreamEvent> {
  yield factory.serverToolStarted(item.id, item.tool, {
    name: item.name,
    serverLabel: item.serverLabel,
  });

  if (streamArguments && item.argumentsText) {
    let chunkIndex = 0;
    for (const chunk of chunkText(item.argumentsText, stream)) {
      await delayForChunk(stream, chunkIndex, chunk.length);
      yield factory.serverToolDelta(item.id, { argumentsText: chunk });
      chunkIndex += 1;
    }
  } else if (item.argumentsText) {
    yield factory.serverToolDelta(item.id, { argumentsText: item.argumentsText });
  }

  yield factory.serverToolCompleted(item.id, {
    status: item.status === "failed" ? "failed" : "completed",
    providerPayload: item.providerPayload,
  });
}

export function resolveStepStreamOptions(
  defaults: ResolvedMockTextStreamOptions | undefined,
  override: MockTextStreamOptions | false | undefined,
  label: string,
): ResolvedMockTextStreamOptions | undefined {
  if (override === false) {
    return undefined;
  }

  return resolveMockTextStreamOptions(override, `${label} stream`, defaults);
}

export function resolveMockTextStreamOptions(
  options: MockTextStreamOptions | undefined,
  label: string,
  defaults?: ResolvedMockTextStreamOptions,
): ResolvedMockTextStreamOptions | undefined {
  if (options === undefined) {
    return defaults;
  }

  const chunkSize = options.chunkSize ?? defaults?.chunkSize ?? 1;
  const initialDelayMs = options.initialDelayMs ?? defaults?.initialDelayMs ?? 0;
  const charsPerSecond = options.charsPerSecond ?? defaults?.charsPerSecond;

  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new AIRequestError(`${label}: chunkSize must be a positive integer`, "MOCK_STREAM_CONFIG_INVALID");
  }

  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
    throw new AIRequestError(`${label}: initialDelayMs must be a non-negative number`, "MOCK_STREAM_CONFIG_INVALID");
  }

  if (charsPerSecond !== undefined && (!Number.isFinite(charsPerSecond) || charsPerSecond <= 0)) {
    throw new AIRequestError(`${label}: charsPerSecond must be a positive number`, "MOCK_STREAM_CONFIG_INVALID");
  }

  return {
    chunkSize,
    initialDelayMs,
    charsPerSecond,
  };
}

export function chunkText(text: string, stream?: ResolvedMockTextStreamOptions): string[] {
  if (!text) {
    return [];
  }

  if (!stream) {
    return [text];
  }

  const chars = Array.from(text);
  const chunks: string[] = [];

  for (let index = 0; index < chars.length; index += stream.chunkSize) {
    chunks.push(chars.slice(index, index + stream.chunkSize).join(""));
  }

  return chunks;
}

export async function delayForChunk(
  stream: ResolvedMockTextStreamOptions | undefined,
  chunkIndex: number,
  chunkLength: number,
): Promise<void> {
  if (!stream) {
    return;
  }

  if (chunkIndex === 0 && stream.initialDelayMs > 0) {
    await sleep(stream.initialDelayMs);
    return;
  }

  if (chunkIndex > 0 && stream.charsPerSecond !== undefined) {
    await sleep((chunkLength / stream.charsPerSecond) * 1000);
  }
}

export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}
