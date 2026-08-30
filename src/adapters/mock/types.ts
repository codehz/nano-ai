/**
 * Mock adapter 公开与内部类型
 */

import type {
  AuxiliaryInfo,
  BillingInfo,
  Citation,
  CompressRequest,
  CompressResult,
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
  ServiceTier,
  StopReason,
  ToolCallItem,
  ToolResultItem,
  Usage,
} from "../../types/index.js";

/** Mock handler 对单个输入 item 的匹配条件。 */
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

/** Mock 请求整体的断言条件。 */
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

/** Mock adapter 记录的一轮请求历史。 */
export type MockHistoryRecord = {
  turnIndex: number;
  requestId: string;
  replay: ReplayItem[];
  toolCalls: ToolCallItem[];
};

/** Mock handler 可读取的当前回合上下文。 */
export type MockHandlerContext = {
  turnIndex: number;
  previousReplay: ReplayItem[];
  pendingToolCalls: readonly ToolCallItem[];
  history: readonly MockHistoryRecord[];
  /** 请求的 AbortSignal，handler 可检查 signal.aborted 提前退出。 */
  signal?: AbortSignal;
  /** 当前请求的 portable reasoningLevel（若设置）。 */
  reasoningLevel?: ReasoningLevel;
  /** 当前请求的 portable serviceTier（若设置）。 */
  serviceTier?: ServiceTier;
};

/** 在 Mock 流中发出 warning。 */
export type MockWarningStep = {
  type: "warning";
  message: string;
  code?: string;
};

/** 在 Mock 流中发出辅助响应信息。 */
export type MockAuxiliaryStep = {
  type: "auxiliary";
  usage?: Usage;
  billing?: BillingInfo;
  auxiliary?: Partial<AuxiliaryInfo>;
};

/** Mock 文本/参数增量的切分和延迟配置。 */
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

/** 在 Mock 流中发出消息 item。 */
export type MockMessageStep = {
  type: "message";
  id?: string;
  content: string | ContentBlock[];
  citations?: Citation[];
  stream?: MockTextStreamOptions | false;
};

/** 在 Mock 流中发出 provider 托管工具调用。 */
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

/** 在 Mock 流中发出 provider 托管工具结果。 */
export type MockServerToolResultStep = {
  type: "server_tool_result";
  item: ServerToolResultItem;
};

/** 在 Mock 流中发出 provider 工具发现列表。 */
export type MockServerToolDiscoveryStep = {
  type: "server_tool_discovery";
  item: ServerToolDiscoveryItem;
};

/** 在 Mock 流中发出 reasoning item。 */
export type MockReasoningStep = {
  type: "reasoning";
  id?: string;
  visibility?: Extract<OutputItem, { type: "reasoning" }>["visibility"];
  content: string | ContentBlock[];
  stream?: MockTextStreamOptions | false;
};

/** 在 Mock 流中发出客户端工具调用。 */
export type MockToolCallStep = {
  type: "tool_call";
  id: string;
  name: string;
  argumentsText: string;
  streamArguments?: boolean;
  stream?: MockTextStreamOptions | false;
};

/** 在 Mock 流中直接发出完整 output item。 */
export type MockOutputStep = {
  type: "output";
  item: Extract<OutputItem, { type: "message" | "reasoning" | "tool_call" }>;
  stream?: MockTextStreamOptions | false;
};

/** 在 Mock 流中完成当前响应并提供完成元数据。 */
export type MockCompleteStep = {
  type: "complete";
  stopReason?: StopReason;
  replay?: ReplayItem[];
  usage?: Usage;
  billing?: BillingInfo;
  auxiliary?: Partial<AuxiliaryInfo>;
  providerMetadata?: Record<string, unknown>;
  rawResponseId?: string;
  warnings?: import("../../types/index.js").StreamWarning[];
};

/** 在 Mock 流中发出可恢复错误。 */
export type MockErrorStep = {
  type: "error";
  message: string;
  code?: string;
  stopReason?: StopReason;
  providerMetadata?: Record<string, unknown>;
};

/** 在 Mock 流中模拟中断。 */
export type MockInterruptStep = {
  type: "interrupt";
};

/** 在 Mock 流中抛出异常。 */
export type MockThrowStep = {
  type: "throw";
  error: string | Error;
};

/** Mock handler 可发出的所有步骤。 */
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

/** 按规范化请求和上下文生成 Mock 流步骤。 */
export type MockHandler = (request: NormalizedRequest, context: MockHandlerContext) => AsyncIterable<MockStep>;

/** 可同步或异步消费的 Mock 步骤来源。 */
export type MockHandlerSource = Iterable<MockStep> | AsyncIterable<MockStep>;

/** 可返回同步/异步步骤来源的 Mock handler。 */
export type MockStaticHandler = (
  request: NormalizedRequest,
  context: MockHandlerContext,
) => MockHandlerSource | Promise<MockHandlerSource>;

/** Mock compress 夹具；未配置时 compress() 抛 MOCK_COMPRESS_NOT_CONFIGURED */
export type MockCompressHandler = (request: CompressRequest) => CompressResult | Promise<CompressResult>;

/** Mock adapter 的构造选项。 */
export type MockAdapterOptions = {
  handler: MockHandler;
  providerMetadata?: Record<string, unknown>;
  /** 可选：实现 ContextCompressCapable 供 compress 契约测试 */
  compressHandler?: MockCompressHandler;
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
