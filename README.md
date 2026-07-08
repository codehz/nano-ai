# nano-ai

统一流式 AI 客户端 — 一套 canonical API，支持真实模型后端和本地 mock 后端（`responses` / `messages` / `chat.completions` / `ollama` / `mock`）。

## 安装

```bash
bun add nano-ai
```

依赖：Bun（内置 `fetch`、`crypto`），无需额外运行时依赖。

## 快速开始

```ts
import { createAIClient, ResponsesAdapter } from "nano-ai";

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
  instructions?: string; // 系统指令
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
| `message`     | 用户 / 助手 / 系统消息              |
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

| 事件                                  | 含义                            |
| ------------------------------------- | ------------------------------- |
| `response.started`                    | 响应开始                        |
| `message.{started,delta,completed}`   | 消息输出                        |
| `reasoning.{started,delta,completed}` | 思维链                          |
| `tool_call.{started,delta,completed}` | 工具调用                        |
| `response.warning`                    | 非致命警告                      |
| `response.auxiliary`                  | usage / billing 辅助信息        |
| `response.completed`                  | 响应结束，内含完整 `AIResponse` |

### 统一终结结果

流结束后可通过 `collectStream()` 聚合为 `AIResponse`：

```ts
import { collectStream } from "nano-ai";

const response = await collectStream(client.stream({ input }));
console.log(response.text); // 全部文本
console.log(response.toolCalls); // 工具调用列表
console.log(response.usage); // token 统计
console.log(response.replay); // 续接材料
```

`AIResponse` 包含：

| 字段         | 类型             | 说明                     |
| ------------ | ---------------- | ------------------------ |
| `output`     | `OutputItem[]`   | 当前轮输出               |
| `replay`     | `ReplayItem[]`   | 续接材料（下次请求带回） |
| `text`       | `string`         | 全部文本拼接             |
| `toolCalls`  | `ToolCallItem[]` | 工具调用                 |
| `stopReason` | `StopReason`     | 终止原因                 |
| `usage`      | `Usage`          | token 统计               |
| `billing`    | `BillingInfo`    | 计费信息                 |
| `warnings`   | `string[]`       | 非致命警告               |
| `backend`    | `BackendTrace`   | 调用链路元数据           |

## 后端 Adapter

| Adapter                 | 类                       | 能力评级 |
| ----------------------- | ------------------------ | -------- |
| OpenAI Responses API    | `ResponsesAdapter`       | 🌟🌟🌟   |
| Anthropic Messages API  | `MessagesAdapter`        | 🌟🌟☆    |
| OpenAI Chat Completions | `ChatCompletionsAdapter` | 🌟☆☆     |
| Ollama Chat API         | `OllamaAdapter`          | 🌟☆☆     |
| Local Mock Backend      | `MockAdapter`            | 调试用   |

```ts
import { ResponsesAdapter, MessagesAdapter, ChatCompletionsAdapter, OllamaAdapter, MockAdapter } from "nano-ai";

// OpenAI Responses API（能力最强）
const responses = new ResponsesAdapter({ apiKey: "sk-..." });

// Anthropic Messages API
const messages = new MessagesAdapter({ apiKey: "sk-ant-..." });

// OpenAI Chat Completions（兼容层）
const chat = new ChatCompletionsAdapter({ apiKey: "sk-..." });

// Ollama
const ollama = new OllamaAdapter({ baseUrl: "http://localhost:11434" });

// 本地 mock 后端
const mock = new MockAdapter({
  rules: [
    { keywords: ["退款", "refund"], response: "退款申请已收到，我们会在 1 个工作日内处理。" },
    { keywords: ["订单", "order"], response: "请提供订单号，我来帮你查询。" },
  ],
  defaultResponse: "暂时无法识别你的问题，请补充更多信息。",
});
```

各 adapter 的能力差异通过 `capabilities` 字段暴露：

```ts
adapter.capabilities.reasoningStreaming; // 是否支持思维链流
adapter.capabilities.toolCallStreaming; // 是否支持工具调用流
adapter.capabilities.replayFidelity; // "high" | "medium" | "low"
```

## Mock 后端

适合前端联调、客服话术演示、离线测试。

`MockAdapter` 会提取请求中的消息文本，按 `rules` 顺序匹配关键词；命中后返回对应模板，未命中则返回 `defaultResponse`。

```ts
import { createAIClient, MockAdapter } from "nano-ai";

const client = createAIClient({
  adapter: new MockAdapter({
    rules: [
      { keywords: ["退款", "refund"], response: "退款申请已收到，我们会在 1 个工作日内处理。" },
      { keywords: ["VIP"], response: "已为你转接 VIP 专属客服。", caseSensitive: true },
    ],
    defaultResponse: "你好，这里是默认 mock 回复。",
  }),
  model: "mock-model",
});
```

规则结构：

```ts
type MockKeywordRule = {
  keywords: string[]; // 任一关键词命中即触发
  response: string | ContentBlock[] | MessageItem; // 返回模板
  caseSensitive?: boolean; // 默认 false
};
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
import { syntheticStream } from "nano-ai";

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
import { AuxiliaryCollector } from "nano-ai";

const collector = new AuxiliaryCollector();
collector.recordUsage({ inputTokens: 10, outputTokens: 5 }, "stream");
collector.recordBilling({ amount: 0.002, currency: "USD", isEstimated: false, source: "provider" }, "final");

const { usage, billing, auxiliary, warnings } = collector.build();
```

## 开发命令

```bash
bun run typecheck    # TypeScript 类型检查
bun run test         # 运行全部测试（228+）
bun run example:basic
bun run example:multi-turn
bun run example:tool-loop
```

## License

MIT
