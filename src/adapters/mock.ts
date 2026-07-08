/**
 * Mock Adapter
 *
 * 面向测试的脚本化 adapter：
 * - 按 turn 顺序消费请求，验证调用方是否正确续接 replay / tool_result
 * - 发出可控的 message / reasoning / tool_call 流
 * - 注入 warning / auxiliary / content_filter / 中断 / provider error
 *
 * 这不是通用“假模型”，而是测试工具调用编排与错误路径的测试夹具。
 */

import { AIRequestError } from "../core/errors.js";
import { AdapterBase } from "../helpers/adapter-base.js";
import { messageItem, reasoningItem, replayFromOutput, textBlock } from "../helpers/mapping.js";

import type {
  AIStreamEvent,
  AuxiliaryInfo,
  BillingInfo,
  ContentBlock,
  EventFactory,
  InputItem,
  MessageItem,
  NormalizedRequest,
  OutputItem,
  ReplayItem,
  StopReason,
  ToolCallItem,
  ToolResultItem,
  Usage,
} from "../index.js";

export type MockInputExpectation = {
  type: InputItem["type"];
  id?: string;
  role?: MessageItem["role"];
  name?: string;
  toolName?: string;
  callId?: string;
  outcome?: ToolResultItem["outcome"];
  visibility?: Extract<InputItem, { type: "reasoning" }>["visibility"];
  source?: Extract<InputItem, { type: "opaque" }>["source"];
  purpose?: Extract<InputItem, { type: "opaque" }>["purpose"];
  textIncludes?: string;
};

export type MockRequestExpectation = {
  minItems?: number;
  maxItems?: number;
  ordered?: boolean;
  requireReplayFromPreviousTurn?: boolean;
  requireToolResultsForPendingCalls?: boolean;
  tools?: "ignore" | "present" | "absent";
  toolChoice?: "ignore" | "present" | "absent";
  items?: MockInputExpectation[];
};

export type MockTurnContext = {
  turnIndex: number;
  previousReplay: ReplayItem[];
  pendingToolCalls: readonly ToolCallItem[];
  history: readonly MockTurnRecord[];
};

export type MockTurnValidator = (
  request: NormalizedRequest,
  context: MockTurnContext,
) => void | Promise<void>;

export type MockWarningStep = {
  type: "warning";
  message: string;
  code?: string;
};

export type MockAuxiliaryStep = {
  type: "auxiliary";
  usage?: Usage;
  billing?: BillingInfo;
  auxiliary?: Partial<AuxiliaryInfo>;
};

export type MockTextStreamOptions = {
  /**
   * 每秒吐出的字符数。未设置时仍会按 chunk 拆分，但不会额外等待。
   */
  charsPerSecond?: number;
  /**
   * 每个 delta 最多包含多少个字符，默认 1。
   */
  chunkSize?: number;
  /**
   * 首个 delta 发出前的延迟。
   */
  initialDelayMs?: number;
};

export type MockMessageStep = {
  type: "message";
  id?: string;
  content: string | ContentBlock[];
  stream?: MockTextStreamOptions | false;
};

export type MockReasoningStep = {
  type: "reasoning";
  id?: string;
  visibility?: Extract<OutputItem, { type: "reasoning" }>["visibility"];
  content: string | ContentBlock[];
  stream?: MockTextStreamOptions | false;
};

export type MockToolCallStep = {
  type: "tool_call";
  id: string;
  name: string;
  argumentsText: string;
  argumentsJson?: unknown;
  streamArguments?: boolean;
  stream?: MockTextStreamOptions | false;
};

export type MockOutputStep = {
  type: "output";
  item: Extract<OutputItem, { type: "message" | "reasoning" | "tool_call" }>;
  stream?: MockTextStreamOptions | false;
};

export type MockCompleteStep = {
  type: "complete";
  stopReason?: StopReason;
  replay?: ReplayItem[];
  usage?: Usage;
  billing?: BillingInfo;
  auxiliary?: Partial<AuxiliaryInfo>;
  providerMetadata?: Record<string, unknown>;
  rawResponseId?: string;
  warnings?: string[];
};

export type MockErrorStep = {
  type: "error";
  message: string;
  code?: string;
  stopReason?: StopReason;
  providerMetadata?: Record<string, unknown>;
};

export type MockInterruptStep = {
  type: "interrupt";
};

export type MockThrowStep = {
  type: "throw";
  error: string | Error;
};

export type MockStep =
  | MockWarningStep
  | MockAuxiliaryStep
  | MockMessageStep
  | MockReasoningStep
  | MockToolCallStep
  | MockOutputStep
  | MockCompleteStep
  | MockErrorStep
  | MockInterruptStep
  | MockThrowStep;

export type MockTurn = {
  name?: string;
  expect?: MockRequestExpectation | MockTurnValidator;
  steps: MockStep[];
};

export type MockAdapterOptions = {
  turns: MockTurn[];
  onExhausted?: "throw" | "repeat-last" | "complete-empty";
  providerMetadata?: Record<string, unknown>;
  stream?: MockTextStreamOptions;
};

type MockTurnRecord = {
  turnIndex: number;
  turnName?: string;
  requestId: string;
  replay: ReplayItem[];
  toolCalls: ToolCallItem[];
};

type MockProviderRequest = {
  request: NormalizedRequest;
  turn: MockTurn;
  turnIndex: number;
  turnName?: string;
  remainingPendingToolCalls: ToolCallItem[];
};

type ResolvedMockTextStreamOptions = {
  charsPerSecond?: number;
  chunkSize: number;
  initialDelayMs: number;
};

export class MockAdapter extends AdapterBase {
  readonly kind = "mock" as const;
  readonly nativeStreaming = false;

  private readonly turns: MockTurn[];
  private readonly onExhausted: NonNullable<MockAdapterOptions["onExhausted"]>;
  private readonly providerMetadata?: Record<string, unknown>;
  private readonly defaultStream?: ResolvedMockTextStreamOptions;

  private cursor = 0;
  private previousReplay: ReplayItem[] = [];
  private pendingToolCalls: ToolCallItem[] = [];
  private history: MockTurnRecord[] = [];
  private activeStream = false;

  constructor(options: MockAdapterOptions) {
    super();
    this.turns = options.turns;
    this.onExhausted = options.onExhausted ?? "throw";
    this.providerMetadata = options.providerMetadata;
    this.defaultStream = resolveMockTextStreamOptions(options.stream, "adapter stream");
  }

  protected async buildRequest(request: NormalizedRequest): Promise<MockProviderRequest> {
    const turnIndex = this.cursor;
    const turn = this.resolveTurn(turnIndex);
    const turnName = turn.name;
    const context = this.buildTurnContext(turnIndex);

    if (turn.expect) {
      if (typeof turn.expect === "function") {
        await turn.expect(request, context);
      } else {
        assertRequestMatchesExpectation(request, turn.expect, context);
      }
    }

    const remainingPendingToolCalls = consumePendingToolCalls(this.pendingToolCalls, request.input);

    this.cursor += 1;

    return {
      request,
      turn,
      turnIndex,
      turnName,
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

      for (const [stepIndex, step] of mockRequest.turn.steps.entries()) {
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
            const item = createMessageFromStep(step, request, mockRequest.turnIndex, stepIndex);
            yield* emitMessage(factory, item, resolveStepStreamOptions(this.defaultStream, step.stream, "message"));
            output.push(item);
            break;
          }
          case "reasoning": {
            const item = createReasoningFromStep(step, request, mockRequest.turnIndex, stepIndex);
            yield* emitReasoning(factory, item, resolveStepStreamOptions(this.defaultStream, step.stream, "reasoning"));
            output.push(item);
            break;
          }
          case "tool_call": {
            const item = createToolCallFromStep(step);
            yield* emitToolCall(
              factory,
              item,
              step.streamArguments ?? true,
              resolveStepStreamOptions(this.defaultStream, step.stream, "tool_call"),
            );
            output.push(item);
            break;
          }
          case "output": {
            assertSupportedOutputItem(step.item);
            const item = attachSyntheticId(step.item, request, mockRequest.turnIndex, stepIndex);
            yield* emitOutputItem(factory, item, resolveStepStreamOptions(this.defaultStream, step.stream, "output"));
            output.push(item);
            break;
          }
          case "complete": {
            const response = this.finalizeTurn(request, factory, mockRequest, output, step);
            yield factory.responseCompleted(response);
            return;
          }
          case "error": {
            yield factory.responseWarning(step.message, step.code);
            const response = this.finalizeTurn(request, factory, mockRequest, output, {
              type: "complete",
              stopReason: step.stopReason ?? "error",
              providerMetadata: step.providerMetadata,
            });
            yield factory.responseCompleted(response);
            return;
          }
          case "interrupt":
            this.pendingToolCalls = mockRequest.remainingPendingToolCalls;
            return;
          case "throw":
            throw typeof step.error === "string" ? new Error(step.error) : step.error;
        }
      }

      const response = this.finalizeTurn(request, factory, mockRequest, output, {
        type: "complete",
      });
      yield factory.responseCompleted(response);
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
  ) {
    const replay = completion.replay ?? replayFromOutput(output);
    const toolCalls = output.filter((item): item is ToolCallItem => item.type === "tool_call");

    this.previousReplay = replay;
    this.pendingToolCalls = [...mockRequest.remainingPendingToolCalls, ...toolCalls];
    this.history.push({
      turnIndex: mockRequest.turnIndex,
      turnName: mockRequest.turnName,
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
          turnName: mockRequest.turnName,
          scriptedSteps: mockRequest.turn.steps.length,
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

  private resolveTurn(turnIndex: number): MockTurn {
    const turn = this.turns[turnIndex];
    if (turn !== undefined) {
      return turn;
    }

    const lastTurn = this.turns.at(-1);
    if (this.onExhausted === "repeat-last" && lastTurn !== undefined) {
      return lastTurn;
    }

    if (this.onExhausted === "complete-empty") {
      return { name: "exhausted", steps: [] };
    }

    throw new AIRequestError(
      `MockAdapter turn ${turnIndex + 1} requested, but only ${this.turns.length} turn(s) were scripted`,
      "MOCK_TURN_EXHAUSTED",
    );
  }

  private buildTurnContext(turnIndex: number): MockTurnContext {
    return {
      turnIndex,
      previousReplay: this.previousReplay.map(cloneItem),
      pendingToolCalls: this.pendingToolCalls.map(cloneItem),
      history: this.history.map((record) => ({
        ...record,
        replay: record.replay.map(cloneItem),
        toolCalls: record.toolCalls.map(cloneItem),
      })),
    };
  }
}

function createMessageFromStep(
  step: MockMessageStep,
  request: NormalizedRequest,
  turnIndex: number,
  stepIndex: number,
): MessageItem {
  return {
    ...messageItem(normalizeBlocks(step.content), {
      id: step.id ?? `mock-msg-${request.requestId}-${turnIndex}-${stepIndex}`,
    }),
    role: "assistant",
  };
}

function createReasoningFromStep(
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

function createToolCallFromStep(step: MockToolCallStep): ToolCallItem {
  return {
    type: "tool_call",
    id: step.id,
    name: step.name,
    argumentsText: step.argumentsText,
    argumentsJson: step.argumentsJson,
  };
}

function normalizeBlocks(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === "string" ? [textBlock(content)] : content;
}

function assertSupportedOutputItem(item: OutputItem): void {
  if (item.type === "opaque") {
    throw new AIRequestError("MockAdapter does not stream opaque output items; use complete.replay if needed", "MOCK_OPAQUE_OUTPUT");
  }
}

function attachSyntheticId(
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

async function* emitOutputItem(
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

async function* emitMessage(
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
        yield factory.messageDelta(item.id, chunk);
        chunkIndex += 1;
      }
    }
  }

  yield factory.messageCompleted(item);
}

async function* emitReasoning(
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

  yield factory.reasoningCompleted(item);
}

async function* emitToolCall(
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

  yield factory.toolCallCompleted(item);
}

function resolveStepStreamOptions(
  defaults: ResolvedMockTextStreamOptions | undefined,
  override: MockTextStreamOptions | false | undefined,
  label: string,
): ResolvedMockTextStreamOptions | undefined {
  if (override === false) {
    return undefined;
  }

  return resolveMockTextStreamOptions(override, `${label} stream`, defaults);
}

function resolveMockTextStreamOptions(
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

function chunkText(text: string, stream?: ResolvedMockTextStreamOptions): string[] {
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

async function delayForChunk(
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

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveStopReason(output: OutputItem[]): StopReason {
  return output.some((item) => item.type === "tool_call") ? "tool_call" : "end_turn";
}

function consumePendingToolCalls(pending: readonly ToolCallItem[], input: readonly InputItem[]): ToolCallItem[] {
  const fulfilledIds = new Set(
    input
      .filter((item): item is ToolResultItem => item.type === "tool_result")
      .map((item) => item.callId),
  );

  return pending.filter((item) => !fulfilledIds.has(item.id)).map(cloneItem);
}

function assertRequestMatchesExpectation(
  request: NormalizedRequest,
  expectation: MockRequestExpectation,
  context: MockTurnContext,
): void {
  const prefix = `MockAdapter turn ${context.turnIndex + 1} expectation failed`;

  if (expectation.minItems !== undefined && request.input.length < expectation.minItems) {
    throw new AIRequestError(`${prefix}: expected at least ${expectation.minItems} input item(s)`, "MOCK_EXPECTATION_FAILED");
  }

  if (expectation.maxItems !== undefined && request.input.length > expectation.maxItems) {
    throw new AIRequestError(`${prefix}: expected at most ${expectation.maxItems} input item(s)`, "MOCK_EXPECTATION_FAILED");
  }

  if (expectation.tools === "present" && (!request.tools || request.tools.length === 0)) {
    throw new AIRequestError(`${prefix}: expected tools to be present`, "MOCK_EXPECTATION_FAILED");
  }

  if (expectation.tools === "absent" && request.tools && request.tools.length > 0) {
    throw new AIRequestError(`${prefix}: expected tools to be absent`, "MOCK_EXPECTATION_FAILED");
  }

  if (expectation.toolChoice === "present" && request.toolChoice === undefined) {
    throw new AIRequestError(`${prefix}: expected toolChoice to be present`, "MOCK_EXPECTATION_FAILED");
  }

  if (expectation.toolChoice === "absent" && request.toolChoice !== undefined) {
    throw new AIRequestError(`${prefix}: expected toolChoice to be absent`, "MOCK_EXPECTATION_FAILED");
  }

  if (expectation.requireReplayFromPreviousTurn && context.previousReplay.length > 0) {
    assertReplayIncluded(request.input, context.previousReplay, prefix);
  }

  if (expectation.requireToolResultsForPendingCalls && context.pendingToolCalls.length > 0) {
    const toolResultIds = new Set(
      request.input
        .filter((item): item is ToolResultItem => item.type === "tool_result")
        .map((item) => item.callId),
    );

    for (const call of context.pendingToolCalls) {
      if (!toolResultIds.has(call.id)) {
        throw new AIRequestError(
          `${prefix}: expected tool_result for pending tool call "${call.id}"`,
          "MOCK_EXPECTATION_FAILED",
        );
      }
    }
  }

  if (expectation.items && expectation.items.length > 0) {
    if (expectation.ordered) {
      assertOrderedItems(request.input, expectation.items, prefix);
    } else {
      assertUnorderedItems(request.input, expectation.items, prefix);
    }
  }
}

function assertReplayIncluded(input: readonly InputItem[], replay: readonly ReplayItem[], prefix: string): void {
  const fingerprints = input.map(fingerprintItem);
  let cursor = 0;

  for (const replayItem of replay) {
    const target = fingerprintItem(replayItem);
    const foundIndex = fingerprints.indexOf(target, cursor);
    if (foundIndex === -1) {
      throw new AIRequestError(`${prefix}: previous replay item was not carried into the next request`, "MOCK_EXPECTATION_FAILED");
    }
    cursor = foundIndex + 1;
  }
}

function assertOrderedItems(input: readonly InputItem[], expectations: readonly MockInputExpectation[], prefix: string): void {
  let cursor = 0;

  for (const expected of expectations) {
    let matched = false;
    while (cursor < input.length) {
      const item = input[cursor];
      if (item !== undefined && matchesItemExpectation(item, expected)) {
        matched = true;
        cursor += 1;
        break;
      }
      cursor += 1;
    }

    if (!matched) {
      throw new AIRequestError(
        `${prefix}: missing ordered input item ${describeExpectation(expected)}`,
        "MOCK_EXPECTATION_FAILED",
      );
    }
  }
}

function assertUnorderedItems(input: readonly InputItem[], expectations: readonly MockInputExpectation[], prefix: string): void {
  for (const expected of expectations) {
    const matched = input.some((item) => matchesItemExpectation(item, expected));
    if (!matched) {
      throw new AIRequestError(
        `${prefix}: missing input item ${describeExpectation(expected)}`,
        "MOCK_EXPECTATION_FAILED",
      );
    }
  }
}

function matchesItemExpectation(item: InputItem, expected: MockInputExpectation): boolean {
  if (item.type !== expected.type) {
    return false;
  }

  if (expected.id !== undefined && "id" in item && item.id !== expected.id) {
    return false;
  }

  switch (item.type) {
    case "message":
      return (
        (expected.role === undefined || item.role === expected.role) &&
        matchesText(item.content, expected.textIncludes)
      );
    case "reasoning":
      return (
        (expected.visibility === undefined || item.visibility === expected.visibility) &&
        matchesText(item.content, expected.textIncludes)
      );
    case "tool_call":
      return (
        (expected.name === undefined || item.name === expected.name) &&
        (expected.textIncludes === undefined || item.argumentsText.includes(expected.textIncludes))
      );
    case "tool_result":
      return (
        (expected.toolName === undefined || item.toolName === expected.toolName) &&
        (expected.callId === undefined || item.callId === expected.callId) &&
        (expected.outcome === undefined || item.outcome === expected.outcome) &&
        matchesText(item.content, expected.textIncludes)
      );
    case "opaque":
      return (
        (expected.source === undefined || item.source === expected.source) &&
        (expected.purpose === undefined || item.purpose === expected.purpose)
      );
  }
}

function matchesText(blocks: readonly ContentBlock[], textIncludes: string | undefined): boolean {
  if (textIncludes === undefined) {
    return true;
  }

  return blocks.some((block) => {
    if (block.type === "text") return block.text.includes(textIncludes);
    if (block.type === "json") return JSON.stringify(block.json).includes(textIncludes);
    return false;
  });
}

function fingerprintItem(item: InputItem): string {
  return JSON.stringify(item);
}

function describeExpectation(expectation: MockInputExpectation): string {
  const parts = [`type=${expectation.type}`];
  if (expectation.role) parts.push(`role=${expectation.role}`);
  if (expectation.name) parts.push(`name=${expectation.name}`);
  if (expectation.toolName) parts.push(`toolName=${expectation.toolName}`);
  if (expectation.callId) parts.push(`callId=${expectation.callId}`);
  if (expectation.textIncludes) parts.push(`textIncludes=${JSON.stringify(expectation.textIncludes)}`);
  return `{ ${parts.join(", ")} }`;
}

function cloneItem<T>(item: T): T {
  return structuredClone(item);
}
