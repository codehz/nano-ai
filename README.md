# @codehz/ai

统一流式 AI 客户端，提供一套 canonical API，对接真实模型后端与面向测试的回调驱动 `MockAdapter`（`responses` / `messages` / `chat-completions` / `ollama` / `mock`）。

## 安装

```bash
bun add @codehz/ai
```

依赖：Bun（内置 `fetch`、`crypto`），无需额外运行时依赖。

## 快速开始

```ts
import { createAIClient, ResponsesAdapter } from "@codehz/ai";

const client = createAIClient({
  adapter: new ResponsesAdapter({ apiKey: process.env.OPENAI_API_KEY! }),
  model: "gpt-4o",
});

const stream = client.stream({
  input: [{ type: "message", role: "user", content: [{ type: "text", text: "What's the weather in Hangzhou?" }] }],
});

for await (const event of stream) {
  if (event.type === "message.delta") {
    process.stdout.write(event.delta.text);
  }
}
```

## 核心概念

### 统一请求模型

所有 adapter 接受同一形状的 `AIRequest`：

```ts
type AIRequest = {
  instructions?: string | InstructionBlock[]; // 系统级指令
  input: InputItem[]; // 输入 items
  tools?: ToolDefinition[]; // 工具声明
  toolChoice?: ToolChoice; // 工具选择策略
  temperature?: number; // 温度 (0–2)
  maxOutputTokens?: number; // 最大输出 token
  include?: { usage?; billing?; providerMetadata? };
};
```

`input` 是 item 数组，每个 item 可以是：

| Item 类型     | 用途                                |
| ------------- | ----------------------------------- |
| `message`     | 用户 / 助手消息                     |
| `reasoning`   | 思维链（输入侧 replay）             |
| `tool_call`   | 模型发起的工具调用（输入侧 replay） |
| `tool_result` | 工具执行结果                        |
| `opaque`      | Provider 私有续接材料               |

### 统一事件流

所有 adapter 产出 `AsyncIterable<AIStreamEvent>`，事件语义一致：

```
response.started → (item.started → item.delta* → item.completed)* → response.completed
```

事件类型：

| 事件                                  | 含义                                        |
| ------------------------------------- | ------------------------------------------- |
| `response.started`                    | 响应开始                                    |
| `message.{started,delta,completed}`   | 消息输出                                    |
| `reasoning.{started,delta,completed}` | 思维链                                      |
| `tool_call.{started,delta,completed}` | 工具调用                                    |
| `response.warning`                    | 非致命警告                                  |
| `response.auxiliary`                  | usage / billing 辅助信息                    |
| `response.completed`                  | 响应结束，携带 replay、终止原因及最终元数据 |

### 统一终结结果

流结束后可通过 `collectStream()` 聚合为 `AIResponse`：

```ts
import { collectStream } from "@codehz/ai";

const response = await collectStream(client.stream({ input }));
console.log(response.text); // 全部文本
console.log(response.toolCalls); // 工具调用列表
console.log(response.usage); // token 统计
console.log(response.replay); // 续接材料
```

`AIResponse` 包含：

| 字段         | 类型             | 说明                      |
| ------------ | ---------------- | ------------------------- |
| `output`     | `OutputItem[]`   | 当前轮输出                |
| `replay`     | `ReplayItem[]`   | 续接材料（下次请求带回）  |
| `text`       | `string`         | 全部文本拼接              |
| `toolCalls`  | `ToolCallItem[]` | 工具调用                  |
| `stopReason` | `StopReason?`    | 终止原因（可选）          |
| `usage`      | `Usage?`         | token 统计（可选）        |
| `billing`    | `BillingInfo?`   | 计费信息（可选）          |
| `auxiliary`  | `AuxiliaryInfo?` | Provider 辅助信息（可选） |
| `warnings`   | `string[]?`      | 非致命警告（可选）        |
| `backend`    | `BackendTrace`   | 调用链路元数据            |

流式 `message.delta` / `reasoning.delta` 保持后端分片粒度；完成态 `output` 中的
`message` / `reasoning` 会合并相邻 `text` content blocks（直接拼接且不添加分隔符），
非文本 block 仍保留原有边界。

## 后端 Adapter

| Adapter                 | 类                       | 说明                    |
| ----------------------- | ------------------------ | ----------------------- |
| OpenAI Responses API    | `ResponsesAdapter`       | OpenAI Responses 端点   |
| Anthropic Messages API  | `MessagesAdapter`        | Anthropic Messages 端点 |
| OpenAI Chat Completions | `ChatCompletionsAdapter` | Chat Completions 端点   |
| Ollama Chat API         | `OllamaAdapter`          | 本地或自托管 Ollama     |
| Scripted Test Backend   | `MockAdapter`            | 脚本化测试夹具          |

```ts
import {
  ResponsesAdapter,
  MessagesAdapter,
  ChatCompletionsAdapter,
  OllamaAdapter,
  MockAdapter,
  withMockStreaming,
} from "@codehz/ai";

// OpenAI Responses API
const responses = new ResponsesAdapter({ apiKey: "sk-..." });

// Anthropic Messages API
const messages = new MessagesAdapter({ apiKey: "sk-ant-..." });

// OpenAI Chat Completions
const chat = new ChatCompletionsAdapter({ apiKey: "sk-..." });

// Ollama
const ollama = new OllamaAdapter({ baseUrl: "http://localhost:11434" });

// 面向测试的回调驱动 mock backend
const mock = new MockAdapter({
  handler: withMockStreaming(
    async function* () {
      yield { type: "message", content: "我先调用天气工具。" };
      yield {
        type: "tool_call",
        id: "mock-call-weather",
        name: "get_weather",
        argumentsText: '{"city":"Hangzhou"}',
      };
    },
    {
      charsPerSecond: 24,
      chunkSize: 1,
    },
  ),
});
```

公开 adapter 接口暴露稳定标识和各维度能力：

```ts
adapter.kind; // "responses" | "messages" | "chat-completions" | ...
adapter.capabilities.textStreaming; // "native" | "synthetic" | "none"
adapter.capabilities.reasoningStreaming;
adapter.capabilities.toolCallStreaming;
adapter.capabilities.replay; // "canonical" | "opaque" | "none"
adapter.capabilities.usage; // "stream" | "final" | "none"
adapter.capabilities.toolResultOutcomes;
```

响应级 `backend.isSyntheticStream` 根据 `textStreaming === "synthetic"` 推导；具体响应内容仍应从
本次事件流、warning 和 `replay` 判断。

## Mock 后端

`MockAdapter` 是一个面向测试的回调驱动 adapter，用来验证长流程工具调用、`replay` 续接和异常路径。

如果你要调试前端逐字渲染效果，可以用 `withMockStreaming()` 给非流式 handler 包一层分片输出：

```ts
const handler = withMockStreaming(
  async function* () {
    yield { type: "message", content: "Streaming preview for the frontend." };
  },
  {
    charsPerSecond: 20, // 每秒约 20 个字符
    chunkSize: 1, // 默认 1，即逐字输出
    initialDelayMs: 150, // 可选：首字前停顿
  },
);
```

默认会发出单个完整 `message.delta`。只有经 `withMockStreaming()` 注入默认流速后，`message` / `reasoning` / `tool_call` 参数才会被拆成多个 delta。单个 step 也可用 `stream: false` 关闭包装器的默认流速配置。

核心思路是每轮请求执行一次 handler：

- handler 会拿到 `request` 和 `context`
- `context` 内建 `previousReplay`、`pendingToolCalls`、`history`
- handler 可脚本化发出 `message` / `reasoning` / `tool_call`
- 可注入 `warning`、`content_filter`、transport interruption、provider-style error
- 可用 `assertMockRequest()` 验证调用方是否把上一轮 `replay` 和当前 `tool_result` 正确带回

```ts
import { assertMockRequest, createAIClient, MockAdapter } from "@codehz/ai";

const client = createAIClient({
  adapter: new MockAdapter({
    handler: async function* (request, context) {
      if (context.turnIndex === 0) {
        assertMockRequest(
          request,
          {
            items: [{ type: "message", role: "user", textIncludes: "weather" }],
            tools: "present",
            toolChoice: "present",
          },
          context,
        );

        yield { type: "message", content: "Checking weather now." };
        yield {
          type: "tool_call",
          id: "mock-call-weather",
          name: "get_weather",
          argumentsText: '{"city":"Hangzhou"}',
        };
        return;
      }

      assertMockRequest(
        request,
        {
          requireReplayFromPreviousTurn: true,
          requireToolResultsForPendingCalls: true,
        },
        context,
      );

      yield { type: "message", content: "Hangzhou is 28C and sunny." };
    },
  }),
  model: "mock-model",
});
```

核心类型：

```ts
type MockHandler = (request: NormalizedRequest, context: MockHandlerContext) => AsyncIterable<MockStep>;

type MockHandlerContext = {
  turnIndex: number;
  previousReplay: ReplayItem[];
  pendingToolCalls: readonly ToolCallItem[];
  history: readonly MockHistoryRecord[];
};
```

测试工具循环时，第二轮通常会要求：

- `requireReplayFromPreviousTurn: true`
- `requireToolResultsForPendingCalls: true`

畸形路径示例：

```ts
yield { type: "message", content: "partial answer" };
yield { type: "interrupt" }; // 不发 response.completed，collectStream() 应失败
```

```ts
yield { type: "warning", message: "content filtered by policy", code: "CONTENT_FILTERED" };
yield { type: "complete", stopReason: "content_filter" };
```

## 多轮对话

库不托管会话状态。调用方自行保留 `response.replay` 并在下一轮带回：

```ts
const transcript: InputItem[] = [{ type: "message", role: "user", content: [{ type: "text", text: "Hello" }] }];

const r1 = await collectStream(client.stream({ input: transcript }));
transcript.push(...r1.replay);
transcript.push({ type: "message", role: "user", content: [{ type: "text", text: "Continue" }] });

const r2 = await collectStream(client.stream({ input: transcript }));
```

详细示例见 [examples/multi-turn.ts](./examples/multi-turn.ts)。

## 手动工具循环

模型返回 `tool_call` → 调用方执行工具 → 下一轮带入 `tool_result`：

```ts
const r1 = await collectStream(client.stream({ input, tools }));

for (const call of r1.toolCalls) {
  const result = await myTool(call);
  input.push(...r1.replay);
  input.push({
    type: "tool_result",
    callId: call.id,
    toolName: call.name,
    outcome: "success",
    content: [{ type: "json", json: result }],
  });
}

const r2 = await collectStream(client.stream({ input, tools }));
```

详细示例见 [examples/tool-loop.ts](./examples/tool-loop.ts)。

## 模拟流式

非流式后端可通过 `syntheticStream()` 包装为规范事件流：

```ts
import { syntheticStream } from "@codehz/ai";

const events = syntheticStream({
  model: "gpt-4o",
  responseId: "req-1",
  backend: { kind: "chat-completions" },
  output: [messageItem([textBlock("Hello")])],
  stopReason: "end_turn",
});

for await (const event of events) {
  // 消费规范事件
}
```

## 辅助信息采集

`AuxiliaryCollector` 提供分层 best-effort 采集（流事件 → headers → lookup → derived）：

```ts
import { AuxiliaryCollector } from "@codehz/ai";

const collector = new AuxiliaryCollector();
collector.recordUsage({ inputTokens: 10, outputTokens: 5 }, "stream");
collector.recordBilling({ amount: 0.002, currency: "USD", isEstimated: false, source: "provider" }, "final");

const { usage, billing, auxiliary, warnings } = collector.build();
```

## 开发命令

`examples/` 下的三个示例默认都基于 `MockAdapter`，可直接运行，无需配置真实模型或 API key。

```bash
bun run typecheck    # TypeScript 类型检查
bun run test         # 运行全部测试
bun run example:basic
bun run example:multi-turn
bun run example:tool-loop
```

## License

MIT
