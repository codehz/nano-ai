/**
 * Mock adapter 公开与内部类型
 */

import type {
  AuxiliaryInfo,
  BillingInfo,
  Citation,
  ContentBlock,
  InputItem,
  MessageItem,
  NormalizedRequest,
  OutputItem,
  ReasoningLevel,
  ReplayItem,
  ServerToolCallItem,
  ServerToolDiscoveryItem,
  ServerToolResultItem,
  StopReason,
  ToolCallItem,
  ToolResultItem,
  Usage,
} from "../../types/index.js";

export type MockInputExpectation = {
  type: InputItem["type"];
  id?: string;
  role?: MessageItem["role"];
  name?: string;
  toolName?: string;
  callId?: string;
  outcome?: ToolResultItem["outcome"] | ServerToolResultItem["outcome"];
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
  serverTools?: "ignore" | "present" | "absent";
  toolChoice?: "ignore" | "present" | "absent";
  items?: MockInputExpectation[];
};

export type MockHistoryRecord = {
  turnIndex: number;
  requestId: string;
  replay: ReplayItem[];
  toolCalls: ToolCallItem[];
};

export type MockHandlerContext = {
  turnIndex: number;
  previousReplay: ReplayItem[];
  pendingToolCalls: readonly ToolCallItem[];
  history: readonly MockHistoryRecord[];
  /** 请求的 AbortSignal，handler 可检查 signal.aborted 提前退出。 */
  signal?: AbortSignal;
  /** 当前请求的 portable reasoningLevel（若设置）。 */
  reasoningLevel?: ReasoningLevel;
};

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
  citations?: Citation[];
  stream?: MockTextStreamOptions | false;
};

export type MockServerToolCallStep = {
  type: "server_tool_call";
  id: string;
  tool: ServerToolCallItem["tool"];
  name?: string;
  argumentsText?: string;
  serverLabel?: string;
  status?: ServerToolCallItem["status"];
  providerPayload?: unknown;
  streamArguments?: boolean;
  stream?: MockTextStreamOptions | false;
};

export type MockServerToolResultStep = {
  type: "server_tool_result";
  item: ServerToolResultItem;
};

export type MockServerToolDiscoveryStep = {
  type: "server_tool_discovery";
  item: ServerToolDiscoveryItem;
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
  | MockServerToolCallStep
  | MockServerToolResultStep
  | MockServerToolDiscoveryStep
  | MockOutputStep
  | MockCompleteStep
  | MockErrorStep
  | MockInterruptStep
  | MockThrowStep;

export type MockHandler = (request: NormalizedRequest, context: MockHandlerContext) => AsyncIterable<MockStep>;

export type MockHandlerSource = Iterable<MockStep> | AsyncIterable<MockStep>;

export type MockStaticHandler = (
  request: NormalizedRequest,
  context: MockHandlerContext,
) => MockHandlerSource | Promise<MockHandlerSource>;

export type MockAdapterOptions = {
  handler: MockHandler;
  providerMetadata?: Record<string, unknown>;
};

export type MockProviderRequest = {
  request: NormalizedRequest;
  handlerResult: AsyncIterable<MockStep>;
  turnIndex: number;
  remainingPendingToolCalls: ToolCallItem[];
};

export type ResolvedMockTextStreamOptions = {
  charsPerSecond?: number;
  chunkSize: number;
  initialDelayMs: number;
};
