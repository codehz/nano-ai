# nano-ai 统一流式 API 设计

## 文档目的

本文档不再停留在“是否可行”的层面，而是把可行性分析收束成一份可实现的设计。

目标是做一个统一 API 的 TypeScript AI 库，对调用方只暴露一套 canonical 接口，背后可接三类后端：

1. `chat.completions`
2. `messages`
3. `responses`

本设计只聚焦一个公开场景：**单轮流式生成**。

额外约束如下：

- 前台接口默认且只支持流式，不设计独立的非流式协议
- 流式输出必须覆盖消息、思维链、工具调用
- 即使后端不支持原生流式，也要由 adapter 模拟出规范流
- 库只负责“当前这一轮模型输出”的观测与归一化
- 不设计 `session()`、`state`、`continuation` 之类的公开会话接口
- 如果下游要实现多轮对话、工具循环、上下文裁剪、持久化，会话编排由下游自己负责

## 结论

这个方向可做，而且应该做成：

- 一套 canonical 流式 API
- 多个 backend adapter
- 一套统一请求模型
- 一套统一事件模型
- 一套显式 replay 合约

但要接受一个前提：三个后端协议并不等价，所以统一 API 不能承诺“所有能力在所有后端完全一致”。正确做法是：

- 对外只给一套统一请求、事件、结果模型
- 对内由 adapter 映射协议差异
- 对隐藏推理上下文采用 `best-effort replay`
- 把后端差异建模成显式 capability

## 设计原则

### 一、只设计流式前台接口

前台 API 不提供 `create(): Promise<AIResponse>` 这种主接口，只提供异步事件流：

```ts
const stream = client.stream({
  instructions: "...",
  input: [userText("What's the weather in Hangzhou?")],
  tools: [weatherTool]
});

for await (const event of stream) {
  // 按事件增量消费
}
```

如果调用方需要一次性结果，可以自己消费完整个流并聚合最终结果；这只是流式协议上的 helper，不是独立协议。

### 二、统一模型必须是 item-oriented

如果统一模型仍然退化成 `messages[]`，会立刻丢掉两个关键语义：

1. `responses` 的 item 级输出
2. `messages` / `responses` 中的 reasoning、thinking、redacted thinking、tool use

所以统一模型必须至少覆盖：

- `message`
- `reasoning`
- `tool_call`
- `tool_result`
- `opaque`

### 三、流结束后必须可重放，但不托管会话

库不维护会话，也不替调用方保存上下文；但每一轮结束后，必须返回足够的信息，让下游仅靠同一个 `stream()` 就能自己拼出下一轮。

调用方如果要做多轮，自己保留：

1. 自己之前发给模型的 `input`
2. 本轮返回的 `response.replay`
3. 下一轮新增的用户输入或 `tool_result`

示例：

```ts
const first = await collectStream(
  client.stream({
    input: [userText("Hello")]
  })
);

const second = client.stream({
  input: [
    userText("Hello"),
    ...first.replay,
    userText("Continue")
  ]
});
```

这里没有任何隐藏的 session 状态；多轮只是下游把“上一轮该保留的东西”重新作为下一轮输入提交。

### 四、工具循环默认手动

流在当前模型轮次结束时必须停止，不允许库在内部继续发起下一轮请求。

模型返回工具调用后：

1. 调用方执行工具
2. 调用方把 `tool_result` 作为下一轮输入继续发起流

库可以提供“收集完整响应”的 helper，但不能：

- 自动执行工具
- 自动拼接并提交 `tool_result`
- 自动继续 agent loop

否则会偏离“调用方完全控制每一轮交互”。

### 五、思维链只做真实透传，不做伪造

统一事件里必须有 `reasoning` 流，但这个流只能承载后端真实暴露的 reasoning / thinking / summary / redacted blocks。

禁止做两类事：

- 后端没给 reasoning 时，库自己从文本里“猜”出思维链
- 把隐藏推理上下文 stringify、裁剪、重写后再回传

### 六、辅助信息单独建模，默认 best-effort

除消息、reasoning、工具调用之外，后端通常还会暴露一类“辅助信息”：

- token usage / token breakdown
- cache hit / cache write 之类的计费相关 token 统计
- provider 直接给出的 billing / cost / line item
- request id、service tier、rate-limit、provider model revision
- 其他只适合观测、审计、计费、排障的元数据

这些信息不属于 `output`，也不属于 `replay`，而是单独的 side channel。

统一 API 应默认按 `best-effort` 收集它们：

- 只要后端主响应、流结束事件、header、SDK 元数据、后续 lookup 接口里有，就应该尽量暴露
- 能 canonical 化的，写入统一字段
- 无法稳定 canonical 化的，保留 provider raw payload
- 拿不到不算请求失败，只进入 warning

也就是说，统一层不承诺“每家后端都能给出同一套完整计费字段”，但承诺“如果 provider 有合法入口，adapter 不应把它吞掉”。

## 前台 API

前台只保留一个主入口：

```ts
type CreateAIClientOptions = {
  adapter: BackendAdapter;
  model: string;
  defaults?: Partial<AIRequest>;
};

declare function createAIClient(
  options: CreateAIClientOptions
): AIClient;

interface AIClient {
  stream(request: AIRequest): AsyncIterable<AIStreamEvent>;
}
```

`AIClient` 不提供：

- `session()`
- `send()`
- `continue()`
- `buildNextRequest()`

这些都属于下游编排层，不属于统一流式内核。

## Canonical 请求模型

```ts
type AIRequest = {
  instructions?: string | ContentBlock[];
  input: InputItem[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  include?: {
    usage?: "off" | "best_effort";
    billing?: "off" | "best_effort";
    providerMetadata?: "off" | "best_effort";
  };
  metadata?: Record<string, string>;
  temperature?: number;
  maxOutputTokens?: number;
};
```

`include` 的默认值应视为：

```ts
{
  usage: "best_effort",
  billing: "best_effort",
  providerMetadata: "best_effort"
}
```

含义不是“必须成功拿到”，而是“如果后端有合法来源，就尽量补齐到最终响应里”。

`input` 的含义不是“本轮新增用户消息”，而是“当前这一轮请求要提交给模型的完整 canonical items”。

如果下游要做多轮：

- 由下游决定保留哪些历史
- 由下游决定窗口裁剪策略
- 由下游决定是否带回 `response.replay`

```ts
type InputItem =
  | MessageItem
  | ReasoningItem
  | ToolCallItem
  | ToolResultItem
  | OpaqueItem;
```

```ts
type MessageItem = {
  type: "message";
  id?: string;
  role: "user" | "assistant" | "system" | "developer";
  content: ContentBlock[];
};
```

```ts
type ToolCallItem = {
  type: "tool_call";
  id: string;
  name: string;
  argumentsText: string;
  argumentsJson?: unknown;
};
```

```ts
type ToolResultItem = {
  type: "tool_result";
  callId: string;
  toolName: string;
  outcome: "success" | "error" | "rejected";
  content: ContentBlock[];
};
```

```ts
type ReasoningItem = {
  type: "reasoning";
  id?: string;
  visibility: "full" | "summary" | "redacted" | "opaque";
  content: ContentBlock[];
};
```

```ts
type OpaqueItem = {
  type: "opaque";
  id?: string;
  source: "responses" | "messages" | "chat.completions" | string;
  purpose: "replay" | "provider_state" | "unknown";
  payload: unknown;
};
```

```ts
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "json"; json: unknown }
  | { type: "image"; imageUrl: string }
  | { type: "binary_ref"; ref: string }
  | { type: "opaque"; payload: unknown };
```

```ts
type StopReason =
  | "end_turn"
  | "tool_call"
  | "max_output_tokens"
  | "content_filter"
  | "error"
  | "unknown";

type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  billableInputTokens?: number;
  billableOutputTokens?: number;
};

type BillingInfo = {
  amount?: number;
  currency?: string;
  isEstimated: boolean;
  source: "provider" | "lookup" | "derived" | "unknown";
  raw?: unknown;
};

type AuxiliaryInfo = {
  usageSource?: "stream" | "final" | "header" | "lookup" | "derived";
  billingSource?: "stream" | "final" | "header" | "lookup" | "derived";
  providerUsage?: unknown;
  providerBilling?: unknown;
  providerMetadata?: Record<string, unknown>;
};

type BackendTrace = {
  requestId?: string;
  rawResponseId?: string;
  adapter: "chat-completions" | "messages" | "responses";
  isSyntheticStream: boolean;
  metadataSources?: string[];
  warnings?: string[];
};
```

## Canonical 终结结果模型

虽然前台不设计非流式接口，但流式在结束时仍然需要产出统一终结结果。

```ts
type AIResponse = {
  id?: string;
  output: OutputItem[];
  replay: ReplayItem[];
  text: string;
  toolCalls: ToolCallItem[];
  stopReason?: StopReason;
  usage?: Usage;
  billing?: BillingInfo;
  auxiliary?: AuxiliaryInfo;
  warnings?: string[];
  backend: BackendTrace;
};
```

```ts
type OutputItem =
  | MessageItem
  | ReasoningItem
  | ToolCallItem
  | OpaqueItem;

type ReplayItem = InputItem;
```

`AIResponse` 只通过最终事件暴露，不作为独立请求返回值。

### `usage`、`billing`、`auxiliary` 的分层

- `usage` 是统一层愿意背书的规范化 token 统计
- `billing` 是统一层愿意背书的规范化计费结果；拿不到就留空，不允许伪造
- `auxiliary` 是 raw / provider-specific 兜底出口，用来保留不能稳定 canonical 化、但调用方仍然可能关心的辅助信息

例如：

- 某后端直接给出 cache token breakdown，adapter 可映射到 `usage.cachedInputTokens`
- 某后端只在 header 里给出 request id 或 service tier，可放进 `auxiliary.providerMetadata`
- 某后端只提供独立 usage lookup 接口，adapter 可在流结束后补查，并把来源标到 `auxiliary.usageSource`

设计重点不是“所有 provider 都统一成一模一样的计费模型”，而是：

- 常见字段尽量 canonical
- provider 特有字段总有 raw 出口
- 最终 `AIResponse` 能承接这两层信息

### `output` 与 `replay` 的区别

- `output` 用于渲染、调试、分析当前这一轮模型实际产出了什么
- `replay` 用于下游在未来某一轮里选择性带回什么

多数简单后端里，`replay` 可能与 `output` 非常接近；但对于支持隐藏推理续接或服务端引用的后端，`replay` 可能额外包含：

- 不能直接渲染的 `opaque` provider payload
- 需要保留但不应解释的 reasoning 壳
- 为下次续接准备的 provider state 句柄

因此：

- 调用方可以展示 `output`
- 调用方应把 `replay` 视为 append-only 的 replay 材料
- 调用方不应依赖 `replay` 的可读性

## 统一流事件模型

## 一、总要求

所有 adapter 都必须产出 `AsyncIterable<AIStreamEvent>`。

无论后端是否支持原生流式，调用方看到的事件语义都一致：

- 先有响应级开始事件
- 再有 item 级开始 / 增量 / 完成事件
- 最后有响应级完成事件

## 二、事件基类

```ts
type StreamEventBase = {
  type: string;
  responseId?: string;
  sequence: number;
  timestamp: string;
  backend: {
    kind: "chat-completions" | "messages" | "responses";
    isSynthetic: boolean;
  };
};
```

## 三、响应级事件

```ts
type ResponseStartedEvent = StreamEventBase & {
  type: "response.started";
  model: string;
};

type ResponseWarningEvent = StreamEventBase & {
  type: "response.warning";
  message: string;
  code?: string;
};

type ResponseAuxiliaryEvent = StreamEventBase & {
  type: "response.auxiliary";
  usage?: Usage;
  billing?: BillingInfo;
  auxiliary?: Partial<AuxiliaryInfo>;
};

type ResponseCompletedEvent = StreamEventBase & {
  type: "response.completed";
  response: AIResponse;
};
```

致命错误不走普通流事件；异步迭代器应直接抛错。原因是 JavaScript 调用方通常需要明确区分：

- 正常终结：收到 `response.completed`
- 异常终结：迭代器抛错

`response.auxiliary` 是可选事件：

- adapter 可以 0 次、1 次或多次发出
- 只要新的辅助信息可用，就可以补丁式发出
- 如果某些信息只能在最后拿到，也可以完全不发该事件，只在 `response.completed` 里给最终结果

这样既兼容“provider 在流末尾才给 usage”的后端，也兼容“需要额外 lookup 才能补齐 billing”的后端。

## 四、消息流事件

```ts
type MessageStartedEvent = StreamEventBase & {
  type: "message.started";
  item: {
    id: string;
    role: "assistant";
  };
};

type MessageDeltaEvent = StreamEventBase & {
  type: "message.delta";
  itemId: string;
  delta: {
    type: "text";
    text: string;
  };
};

type MessageCompletedEvent = StreamEventBase & {
  type: "message.completed";
  item: MessageItem;
};
```

消息流只负责可见输出，不承载 reasoning 或工具调用。

## 五、思维链流事件

```ts
type ReasoningStartedEvent = StreamEventBase & {
  type: "reasoning.started";
  item: {
    id: string;
    visibility: "full" | "summary" | "redacted" | "opaque";
  };
};

type ReasoningDeltaEvent = StreamEventBase & {
  type: "reasoning.delta";
  itemId: string;
  delta: ContentBlock;
};

type ReasoningCompletedEvent = StreamEventBase & {
  type: "reasoning.completed";
  item: ReasoningItem;
};
```

约束：

- `visibility` 由 adapter 根据后端真实能力标记
- `full` 仅用于后端明确允许暴露完整 reasoning 的情况
- `summary` 用于后端提供 reasoning summary
- `redacted` 用于只给出可回放但不可见的 reasoning 壳
- `opaque` 用于只能续接、不能解释的原样块

## 六、工具调用流事件

```ts
type ToolCallStartedEvent = StreamEventBase & {
  type: "tool_call.started";
  item: {
    id: string;
    name: string;
  };
};

type ToolCallDeltaEvent = StreamEventBase & {
  type: "tool_call.delta";
  itemId: string;
  delta: {
    argumentsText?: string;
  };
};

type ToolCallCompletedEvent = StreamEventBase & {
  type: "tool_call.completed";
  item: ToolCallItem;
};
```

工具结果不是模型当前输出的一部分，而是未来某一轮的输入，所以当前轮不需要 `tool_result.*` 输出事件。

## 七、统一事件联合

```ts
type AIStreamEvent =
  | ResponseStartedEvent
  | ResponseWarningEvent
  | ResponseAuxiliaryEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | ReasoningStartedEvent
  | ReasoningDeltaEvent
  | ReasoningCompletedEvent
  | ToolCallStartedEvent
  | ToolCallDeltaEvent
  | ToolCallCompletedEvent
  | ResponseCompletedEvent;
```

## 默认流式语义

## 一、原生流式后端

若后端支持原生流式，adapter 直接做协议映射：

- 后端事件 -> canonical 事件
- 后端结束 -> 聚合最终 `AIResponse`
- 后端原生 usage / id / replay 相关数据 -> 写入 `response.completed`
- 若中途拿到 usage / billing / metadata，可提前发 `response.auxiliary`

## 二、非原生流式后端

即使后端只提供一次性响应，adapter 仍必须产出规范事件流。

规则如下：

1. 先发 `response.started`
2. 解析完整响应为 canonical output items
3. 若完整响应里已经包含辅助信息，可先发 `response.auxiliary`
4. 按 item 顺序发出 `*.started`
5. 每个 item 仅发一块 `*.delta`（包含完整字段内容）
6. 发出 `*.completed`
7. 最后发 `response.completed`

## 三、模拟流式的边界

模拟流式仅用于兼容非流式后端，不是模拟流式输出的“感觉”。

它唯一的存在理由是：前台 API 只暴露 `AsyncIterable<AIStreamEvent>`，非流式后端必须满足这个签名才能接入统一事件管道。

因此模拟流式不做精细分块，而是**在最后阶段一次性发出完整结果**：

1. adapter 拿到完整响应后解析成 canonical items
2. 判断后端能力和响应内容确定 item 序列
3. 一次性发出所有事件（started -> delta -> completed 按序走完，delta 仅一块）

这意味调用方看到的 `message.delta` 可能只有一条完整文本，而不是逐 token 递增。

约束：

- 遵守 item 边界
- 不发明不存在的 reasoning
- 不重写工具参数
- 不打乱后端原始顺序

换言之，模拟流式是“协议兼容层”，不是“体验模拟层”。调用方不应依赖 delta 粒度做逐字渲染；需要逐字效果的应用应在前台自己做字符节流渲染。

## Replay 合约

`response.replay` 是这份设计里唯一和“未来下一轮”有关的公开约定。

它不是会话状态对象，而是一组由 adapter 生成、可由调用方自行保存和重放的 canonical items。

原则：

1. `replay` 只描述“如果你以后要续接，本轮哪些材料值得保留”
2. `replay` 的所有权在调用方，不在库
3. `replay` 允许包含不可读的 `opaque` payload
4. `replay` 不能要求调用方理解 provider 私有语义，只要求原样保留

## 辅助信息采集策略

辅助信息的收集顺序应当显式约定，否则不同 adapter 容易一会儿查 header、一会儿查 body、一会儿完全不查。

推荐优先级如下：

1. 当前主响应 body / stream terminal event
2. 当前 HTTP headers / trailers
3. SDK 暴露的 response metadata
4. 通过 response id 发起的一次 follow-up lookup
5. 本地可推导但不具权威性的估算

约束：

- 1 到 4 拿到的是 provider 事实，允许映射为 canonical 字段
- 第 5 类只能标成 `billing.source === "derived"` 或 `auxiliary.*Source === "derived"`
- `best_effort` 不意味着无限重试；最多做一次有界的 follow-up lookup
- lookup 失败只记 warning，不把整轮请求判为失败
- 如果 adapter 根本没有权限或没有 response id，就应直接跳过 lookup

这保证“能拿就拿”，但不会让辅助信息反过来绑架主生成链路。

### 下游如何基于 `replay` 自己实现多轮

最直接的方式是由下游维护一份 transcript：

```ts
const transcript: InputItem[] = [];

transcript.push(userText("What's the weather in Hangzhou?"));

const first = await collectStream(
  client.stream({
    input: transcript,
    tools: [weatherTool]
  })
);

transcript.push(...first.replay);
```

如果当前轮返回了工具调用：

```ts
for (const call of first.toolCalls) {
  transcript.push({
    type: "tool_result",
    callId: call.id,
    toolName: call.name,
    outcome: "success",
    content: [{ type: "json", json: await runTool(call) }]
  });
}

const second = client.stream({
  input: transcript
});
```

这个流程只用到了一个接口：`client.stream()`。

### 为什么不用 `state`

`state` 看似简洁，实际会把几个本来应该由下游自己决定的问题提前固化进库：

- 历史是否完整保留，还是做窗口裁剪
- 是不是要持久化到数据库
- 工具结果要不要和普通消息分开存
- provider 私有 replay 材料如何和业务 transcript 对齐

这些都不是统一流式内核该替用户决定的事。

## 各后端的 replay 策略

### 一、`responses`

优先策略：

- 在 `output` 中暴露可见 message / reasoning / tool call
- 在 `replay` 中额外保留 provider 需要的 opaque continuation 材料
- 若后端支持通过 ID 续接，可把该句柄封装为 `opaque` replay item，而不是公开 `previous_response_id`

能力判断：

- replay fidelity: 高
- hidden reasoning replay: 强
- reasoning stream: 强

### 二、`messages`

优先策略：

- 在 `output` 中暴露消息、thinking、tool use
- 在 `replay` 中保留需要原样带回的 thinking / redacted thinking / tool related blocks
- 无法 canonical 化但续接仍有价值的内容，落到 `opaque`

能力判断：

- replay fidelity: 中
- hidden reasoning replay: 条件支持
- reasoning stream: 条件支持

### 三、`chat.completions`

优先策略：

- 在 `output` 中暴露显式消息和工具调用
- 在 `replay` 中保留可重放的显式 message / tool_call 结构
- 不承诺隐藏 reasoning replay

能力判断：

- replay fidelity: 低到中
- hidden reasoning replay: 不保证
- reasoning stream: 通常无

## 工具调用设计

## 一、统一工具定义

```ts
type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};
```

```ts
type ToolChoice =
  | "auto"
  | "none"
  | { type: "tool"; name: string };
```

这里的 `ToolDefinition` 只描述“本轮暴露给模型的工具接口”，不绑定本地 handler。

也就是说：

- 库不维护全局工具注册表
- `tools` 不是“可直接执行的函数列表”，只是发给模型的声明
- 是否真的执行某个 `tool_call`，由调用方在本轮结束后自行决定

这样调用方才能在每一轮里自由做策略控制，例如：

- 按租户、权限、预算动态裁剪本轮可用工具
- 对同一个 `tool_call` 先做确认、审计、缓存命中判断，再决定是否执行
- 拒绝执行模型请求的工具，并显式把拒绝结果回传给模型
- 在工具调用后改写下一轮的 `input` / `tools` / `toolChoice`

## 二、轮次边界必须显式暴露

`stream()` 的职责是“产出当前这一轮模型实际输出”，不是“帮调用方把工具回合跑完”。

因此工具相关的标准边界是：

1. `client.stream()` 产出 `tool_call.*`
2. 当前轮以 `response.completed` 结束，且 `response.stopReason === "tool_call"`
3. 调用方读取 `response.toolCalls` 和 `response.replay`
4. 调用方决定下一轮要不要执行工具、执行哪些工具、是否改写参数或直接拒绝
5. 调用方显式发起下一轮 `client.stream()`

库不能把第 4 步和第 5 步藏进默认封装里；否则调用方失去对轮次节奏的控制。

## 三、工具结果必须由调用方显式构造

`tool_result` 不是工具执行器自动生成的内部结构，而是调用方写入未来请求 `input` 的显式 item。

因此它必须能表达三类场景：

1. 工具执行成功
2. 工具执行失败
3. 工具被调用方拒绝或跳过

示例：

```ts
const ok: ToolResultItem = {
  type: "tool_result",
  callId: toolCall.id,
  toolName: toolCall.name,
  outcome: "success",
  content: [{ type: "json", json: weatherPayload }]
};

const denied: ToolResultItem = {
  type: "tool_result",
  callId: toolCall.id,
  toolName: toolCall.name,
  outcome: "rejected",
  content: [{ type: "text", text: "Tool execution was denied by the caller." }]
};
```

这保证了“工具结果”始终是调用方的决定，而不是库内副作用。

## 四、下一轮请求仍然只是普通 `stream()`

工具回合结束后，不应进入一个特殊的“继续工具循环接口”。

下一轮仍然必须通过同一个 `client.stream()` 发起，只是由调用方自己组装下一轮 `input`：

```ts
const transcript: InputItem[] = [
  userText("What's the weather in Hangzhou?"),
  ...first.replay,
  toolResult
];

const stream = client.stream({
  input: transcript,
  tools: nextTools,
  toolChoice: "auto"
});
```

这点很关键，因为调用方在工具回合之后可能会：

- 换一组工具
- 降低模型能力或切换模型
- 插入新的用户消息
- 不提交任何工具结果，改为走人工兜底

如果 API 单独提供一个“继续工具执行”的封装入口，就会把这些合法场景变成旁路。

## Adapter 接口

adapter 对前台只暴露一个统一适配点：

```ts
interface BackendAdapter {
  readonly kind: "chat-completions" | "messages" | "responses";
  readonly capabilities: AdapterCapabilities;
  stream(request: NormalizedRequest): AsyncIterable<AIStreamEvent>;
}
```

```ts
type NormalizedRequest = AIRequest & {
  model: string;
  requestId: string;
};

type AdapterCapabilities = {
  nativeStreaming: boolean;
  messageStreaming: boolean;
  reasoningStreaming: boolean;
  toolCallStreaming: boolean;
  hiddenReasoningReplay: "full" | "partial" | "none";
  replayFidelity: "high" | "medium" | "low";
  tools: boolean;
  usage: "full" | "partial" | "none";
  billing: "direct" | "lookup" | "derived" | "none";
  providerMetadata: boolean;
};
```

内部实现可以拆成 `build` / `invoke` / `parse` / `emit` 四层，但对外语义必须固定：

- 前台只认 canonical request
- adapter 总是产出 canonical stream
- adapter 自己决定走原生流式还是模拟流式
- adapter 自己决定如何从 `input` 里的 replay 材料还原 provider 请求

## 聚合器设计

由于前台只暴露流式协议，库内部需要一个统一聚合器把事件流还原为最终 `AIResponse`。

职责：

- 合并 `message.delta` 为 `MessageItem`
- 合并 `reasoning.delta` 为 `ReasoningItem`
- 合并 `tool_call.delta` 为 `ToolCallItem`
- 合并 `response.auxiliary` 补丁
- 构建 `output`
- 汇总 `text`
- 生成 `replay`

约束：

- 聚合器不能发明未出现的 item
- 聚合器不能解释 opaque payload
- 聚合器必须保持事件顺序稳定
- `replay` 的生成规则必须由 adapter 显式提供，不能靠聚合器猜
- `usage` / `billing` / `auxiliary` 的最终值必须来自事件或 adapter 显式提供的数据，不能由聚合器自行估算并冒充 provider 结果

`response.completed` 中的 `response` 必须来自同一套聚合规则，不能每个 adapter 自己拼不同形状。

## 错误与中断

## 一、致命错误

以下情况应直接让异步迭代器抛错：

- 请求构造失败
- 后端调用失败
- 后端流协议损坏
- adapter 无法把返回值映射到 canonical 模型

## 二、中途断流

若流在 `response.completed` 之前中断：

- 本轮不产出最终 `AIResponse`
- 调用方是否重试，由调用方自己决定
- adapter 可选择暴露 warning，但不能伪造完成事件

## 三、非致命差异

以下情况进入 `warnings` 或 `response.warning`：

- reasoning 只能以 `summary` 或 `opaque` 暴露
- 工具参数只拿到完整块，无法逐增量拆分
- usage 字段缺失
- billing 字段缺失或只能给估算值
- follow-up lookup 失败、超时或无权限
- replay fidelity 降级

## 能力矩阵

| 能力 | responses | messages | chat.completions |
|---|---|---|---|
| 文本流 | 强 | 强 | 强 |
| 工具调用流 | 强 | 强 | 中 |
| 思维链流 | 强 | 条件支持 | 弱或无 |
| hidden reasoning replay | 强 | 条件支持 | 不保证 |
| replay fidelity | 高 | 中 | 低到中 |
| usage / token 统计 | best-effort | best-effort | best-effort |
| billing / cost 信息 | best-effort | best-effort | best-effort |
| item 级统一映射 | 强 | 中 | 弱 |

这张表必须落在代码里，而不是只存在文档中。

## 调用示例

## 一、单轮流式

```ts
const stream = client.stream({
  instructions: "You are a helpful assistant.",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "text", text: "What's the weather in Hangzhou?" }]
    }
  ],
  tools: [weatherTool]
});

for await (const event of stream) {
  switch (event.type) {
    case "message.delta":
      process.stdout.write(event.delta.text);
      break;
    case "reasoning.delta":
      renderReasoning(event.delta);
      break;
    case "tool_call.completed":
      queueToolCall(event.item);
      break;
    case "response.auxiliary":
      observeAux(event);
      break;
    case "response.completed":
      persistForReplay(event.response.replay);
      break;
  }
}
```

## 二、下游自己做多轮

```ts
const transcript: InputItem[] = [
  userText("What's the weather in Hangzhou?")
];

const first = await collectStream(
  client.stream({
    input: transcript,
    tools: [weatherTool]
  })
);

transcript.push(...first.replay);
transcript.push(userText("Use celsius and answer in Chinese."));

const second = client.stream({
  input: transcript
});
```

这里没有任何 session API；下游只是显式维护自己的 transcript。

## 三、工具循环

```ts
const transcript: InputItem[] = [
  userText("What's the weather in Hangzhou?")
];

const first = await collectStream(
  client.stream({
    input: transcript,
    tools: [weatherTool]
  })
);

transcript.push(...first.replay);

if (first.stopReason !== "tool_call") {
  return first;
}

for (const call of first.toolCalls) {
  if (!allowToolCall(call)) {
    transcript.push({
      type: "tool_result",
      callId: call.id,
      toolName: call.name,
      outcome: "rejected",
      content: [
        { type: "text", text: "The caller rejected this tool call." }
      ]
    });
    continue;
  }

  try {
    transcript.push({
      type: "tool_result",
      callId: call.id,
      toolName: call.name,
      outcome: "success",
      content: [
        { type: "json", json: await runTool(call) }
      ]
    });
  } catch (error) {
    transcript.push({
      type: "tool_result",
      callId: call.id,
      toolName: call.name,
      outcome: "error",
      content: [
        { type: "text", text: String(error) }
      ]
    });
  }
}

const second = client.stream({
  input: transcript,
  tools: pickToolsForSecondTurn(first)
});
```

## 实施顺序

1. 定义 canonical types：request、event、response、replay
2. 实现统一聚合器：把事件流聚合为 `AIResponse`
3. 实现 `responses` adapter：优先打通最强 item 模型和 replay fidelity
4. 实现 `messages` adapter：补 thinking / tool use / replay 映射
5. 实现 `chat.completions` adapter：补弱能力兼容
6. 实现辅助信息采集层：统一 usage / billing / metadata 的 best-effort 合并与 lookup 策略
7. 实现模拟流式层：用于非原生流式后端和测试
8. 为三类后端补 capability 测试、replay 回放测试、工具循环测试、usage / billing 回填测试

## 不做的事

当前设计不包含：

- `session()` 接口
- 自动会话状态托管
- 自动工具执行
- 自动 agent loop
- 自动上下文裁剪策略
- provider 专有托管工具统一抽象
- 为流式再平行设计一套独立非流式公开协议

## 最终判断

这套设计的核心不是“统一一次性响应”，而是“统一一条只描述当前轮次、但可被下游重放的事件流”。

因此 v1 的正确落点应该是：

- 前台只有一个 canonical 入口：`stream()`
- 消息、reasoning、工具调用都按 item 和 event 建模
- 会话编排不进内核，只通过 `response.replay` 暴露最小 replay 合约
- 后端差异通过 adapter 和 capability 吸收
- 后端不支持流式时由 adapter 模拟流式，而不是把前台 API 降级成非流式

这比“先做 session，再试图把单轮流补进去”更合理，因为一旦公开 API 先按会话托管定型，后续想退回到更通用的流式内核，通常会把状态模型、工具循环边界、provider 私有续接策略全部推翻重来。

## 参考资料

- OpenAI Text generation / Responses guide: https://developers.openai.com/api/docs/guides/text
- OpenAI Chat API reference: https://developers.openai.com/api/reference/resources/chat
- Anthropic Messages API: https://platform.claude.com/docs/en/api/messages
- Anthropic Tool use: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- Anthropic Extended thinking: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
