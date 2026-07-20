# @codehz/ai

统一流式 AI 客户端，提供一套 canonical API，对接真实模型后端与面向测试的回调驱动 `MockAdapter`（`responses` / `messages` / `chat-completions` / `ollama` / `gemini` / `mock`）。

## 0.5.0 迁移说明

`0.5.0` 收紧了根入口 `@codehz/ai` 的公开面。以下符号**不再**从包根导出（内部模块，不构成 semver 公开面）：

- `AdapterBase` / `createEventFactory` / `aggregateEvents`
- `normalizeRequest` / `validateRequest` / `assertValidRequest`
- `NormalizedRequestMapper` / `IncrementalStreamParser` / `openProviderJsonStream` 等 transport 脚手架
- `syntheticStream` / `AuxiliaryCollector` / usage 与 provider reasoning 映射函数
- `assertOpaqueReplayEnvelope` 等 security 工具

**仍从根导出：** `createAIClient`、`collectStream`、错误类型与 `WarningCode`、全部 adapters 与 Mock 夹具、canonical 构造（`textBlock` / `messageItem` 等）、`REASONING_LEVELS`，以及全部 canonical 类型。

自定义 adapter 请实现 `BackendAdapter` 接口；库内部测试可通过源码 deep import 访问 `src/provider/*` / `src/stream/*`，但这些路径不保证稳定。

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
  tools?: ToolDefinition[]; // 客户端函数工具（由调用方执行）
  serverTools?: ServerToolDefinition[]; // Provider 托管工具（web_search / code_execution / mcp）
  toolChoice?: ToolChoice; // 客户端工具选择策略
  temperature?: number; // 温度 (0–2)
  maxOutputTokens?: number; // 最大输出 token
  reasoningLevel?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; // 可移植思考力度
  include?: { usage?; billing?; providerMetadata? };
};
```

`tools` 与 `serverTools` 可在同一请求中共存。客户端 `tool_call` / 手动 tool-loop 语义不变；服务端工具由 provider 在请求内执行，**不会**把 `stopReason` 设为 `tool_call`。

`reasoningLevel` 是 portable 枚举，由各 adapter 映射到 provider 原生字段；未设置时不写相关 wire 字段。adapter 无法映射的 level（如 Ollama 的 `minimal` / `xhigh` / `max`）会抛 `AIRequestError`（`UNSUPPORTED_REASONING_LEVEL`）。需要 budget / summary 等特化参数时，仍可用构造期 `extraBody` 覆盖同名顶层键。

| Adapter | 映射 |
| --- | --- |
| `ResponsesAdapter` | `reasoning: { effort }` |
| `ChatCompletionsAdapter` | 顶层 `reasoning_effort` |
| `MessagesAdapter` | `thinking: { type: "disabled" }` 或 `{ type: "enabled", budget_tokens }`（由 `maxOutputTokens` 按比例推导，默认 4096） |
| `OllamaAdapter` | `think: false \| "low" \| "medium" \| "high"` |
| `GeminiAdapter` | `generationConfig.thinkingConfig`（`none` 关闭 thoughts；`minimal`/`low`/`medium`/`high` → `thinkingLevel`；`xhigh`/`max` 不支持） |
| `MockAdapter` | 透传到 `MockHandlerContext.reasoningLevel` |

`input` 是 item 数组，每个 item 可以是：

| Item 类型                 | 用途                                          |
| ------------------------- | --------------------------------------------- |
| `message`                 | 用户 / 助手消息（可带 `citations`）           |
| `reasoning`               | 思维链（输入侧 replay）                       |
| `tool_call`               | 客户端工具调用（输入侧 replay）               |
| `tool_result`             | 客户端工具执行结果                            |
| `server_tool_call`        | Provider 托管工具调用                         |
| `server_tool_result`      | Provider 托管工具结果                         |
| `server_tool_discovery`   | MCP 等远端工具发现列表                        |
| `opaque`                  | Provider 私有续接材料                         |

### 统一事件流

所有 adapter 产出 `AsyncIterable<AIStreamEvent>`，事件语义一致：

```
response.started → (item.started → item.delta* → item.completed)* → response.completed
```

事件类型：

| 事件                                           | 含义                                        |
| ---------------------------------------------- | ------------------------------------------- |
| `response.started`                             | 响应开始                                    |
| `message.{started,delta,completed}`            | 消息输出（`completed` 可带 `citations`）    |
| `reasoning.{started,delta,completed}`          | 思维链                                      |
| `tool_call.{started,delta,completed}`          | 客户端工具调用                              |
| `server_tool.{started,delta,completed}`        | 服务端工具调用                              |
| `server_tool_result.completed`                 | 服务端工具结果（原子）                      |
| `server_tool_discovery.completed`              | MCP 工具发现（原子）                        |
| `response.warning`                             | 非致命警告                                  |
| `response.auxiliary`                           | usage / billing 辅助信息                    |
| `response.completed`                           | 响应结束，携带 replay、终止原因及最终元数据 |

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

| 字段                 | 类型                     | 说明                      |
| -------------------- | ------------------------ | ------------------------- |
| `output`             | `OutputItem[]`           | 当前轮输出                |
| `replay`             | `ReplayItem[]`           | 续接材料（下次请求带回）  |
| `text`               | `string`                 | 全部文本拼接              |
| `toolCalls`          | `ToolCallItem[]`         | 客户端工具调用            |
| `serverToolCalls`    | `ServerToolCallItem[]`   | 服务端工具调用            |
| `serverToolResults`  | `ServerToolResultItem[]` | 服务端工具结果            |
| `stopReason`         | `StopReason?`            | 终止原因（可选）          |
| `usage`              | `Usage?`                 | token 统计（可选）        |
| `billing`            | `BillingInfo?`           | 计费信息（可选）          |
| `auxiliary`          | `AuxiliaryInfo?`         | Provider 辅助信息（可选） |
| `warnings`           | `string[]?`              | 非致命警告（可选）        |
| `backend`            | `BackendTrace`           | 调用链路元数据            |

流式 `message.delta` / `reasoning.delta` 保持后端分片粒度；完成态 `output` 中的
`message` / `reasoning` 会合并相邻 `text` content blocks（直接拼接且不添加分隔符），
非文本 block 仍保留原有边界。

## 后端 Adapter

| Adapter                 | 类                       | 说明                              |
| ----------------------- | ------------------------ | --------------------------------- |
| OpenAI Responses API    | `ResponsesAdapter`       | OpenAI Responses 端点             |
| Anthropic Messages API  | `MessagesAdapter`        | Anthropic Messages 端点           |
| OpenAI Chat Completions | `ChatCompletionsAdapter` | Chat Completions 端点             |
| Ollama Chat API         | `OllamaAdapter`          | 本地或自托管 Ollama               |
| Google Gemini API       | `GeminiAdapter`          | Gemini `streamGenerateContent`    |
| Scripted Test Backend   | `MockAdapter`            | 脚本化测试夹具                    |

```ts
import {
  ResponsesAdapter,
  MessagesAdapter,
  ChatCompletionsAdapter,
  OllamaAdapter,
  GeminiAdapter,
  MockAdapter,
  withMockStreaming,
} from "@codehz/ai";

// OpenAI Responses API
const responses = new ResponsesAdapter({
  apiKey: "sk-...",
  // 可选：自定义请求头 / body 额外顶层字段（构造期静态，后写覆盖内置鉴权头与同名 body 键）
  headers: { "OpenAI-Organization": "org-..." },
  extraBody: { top_p: 0.9 },
});

// Anthropic Messages API
const messages = new MessagesAdapter({
  apiKey: "sk-ant-...",
  headers: { "anthropic-beta": "..." },
  extraBody: { top_p: 0.9 },
});

// OpenAI Chat Completions
const chat = new ChatCompletionsAdapter({
  apiKey: "sk-...",
  headers: { "OpenAI-Organization": "org-..." },
  extraBody: { top_p: 0.9 },
});

// Ollama
const ollama = new OllamaAdapter({
  baseUrl: "http://localhost:11434",
  headers: { "X-Custom": "..." },
  extraBody: { keep_alive: "10m" },
});

// Google Gemini Developer API（原生 generateContent 流，非 OpenAI 兼容层）
const gemini = new GeminiAdapter({
  apiKey: process.env.GEMINI_API_KEY!,
  // 可选：代理 / Vertex 兼容端点
  // baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  headers: { "X-Custom": "..." },
  extraBody: { safetySettings: [] },
});

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

公开 adapter 接口暴露稳定标识和流来源：

```ts
adapter.kind; // "responses" | "messages" | "chat-completions" | ...
adapter.isSyntheticStream;
```

响应级 `backend.isSyntheticStream` 使用同一标记；具体响应内容仍应从
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
- handler 可脚本化发出 `message` / `reasoning` / `tool_call` / `server_tool_*`
- message step 可附带 `citations`
- 可注入 `warning`、`content_filter`、transport interruption、provider-style error
- 可用 `assertMockRequest()` 验证 `replay` / `tool_result` / `serverTools` 等期望

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

## 服务端工具（`serverTools`）

Provider 托管工具（不进客户端 tool loop）。首版由 `ResponsesAdapter` 落地：

| Canonical `serverTools` | Responses wire | 说明 |
| ----------------------- | -------------- | ---- |
| `web_search` | `type: "web_search"` | 域名过滤、`userLocation`、`searchContextSize` |
| `code_execution` | `type: "code_interpreter"` | 仅 auto container（`memoryLimit` / `fileIds`） |
| `mcp` | `type: "mcp"` | 远程 MCP；**仅** `requireApproval: "never"` |

```ts
const stream = client.stream({
  input: [{ type: "message", role: "user", content: [{ type: "text", text: "杭州今天天气？" }] }],
  serverTools: [
    {
      type: "web_search",
      allowedDomains: ["example.com"],
      searchContextSize: "low",
    },
    {
      type: "code_execution",
      container: { type: "auto", memoryLimit: "4g" },
    },
    {
      type: "mcp",
      serverLabel: "dmcp",
      serverUrl: "https://dmcp-server.example/mcp",
      requireApproval: "never",
      // authorization 每请求由调用方重传；不会写入 opaque 回放
      authorization: process.env.MCP_TOKEN,
    },
  ],
});

const result = await collectStream(stream);
console.log(result.serverToolCalls);
console.log(result.serverToolResults);
// 消息 citations（url / container_file）挂在 MessageItem.citations
```

支持矩阵：

| Adapter | `serverTools` |
| --- | --- |
| `ResponsesAdapter` | 请求映射 + SSE 解析 |
| `MockAdapter` | 可脚本化产出 `server_tool_*` 事件与 citations |
| `ChatCompletions` / `Messages` / `Ollama` / `Gemini` | 传入非空 `serverTools` → `AIRequestError`（`UNSUPPORTED_SERVER_TOOL`） |

范围说明（刻意不做）：

- 客户端自动 tool-loop（仍由调用方编排）
- computer_use / shell 托管
- Chat Completions 搜索专用模型
- MCP approval 交互回路（出现 `mcp_approval_request` 会 `response.warning`）
- Containers REST 管理 API

多轮续写推荐用 Responses 的 `previous_response_id` opaque replay，无需把 server tool result 当客户端 `tool_result` 回传。Mock 演示见 [examples/server-tools.ts](./examples/server-tools.ts)。

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

真实 adapter 在原生流不可用时，库内部会用 synthetic 路径包装为规范事件流。应用层一般只需消费 `client.stream()` / `collectStream()`；`0.5.0` 起 `syntheticStream` 不再从根入口导出。

若只需前端逐字预览效果，请优先使用 `MockAdapter` + `withMockStreaming()`（见上文 Mock 后端）。

## 辅助信息采集

usage / billing / providerMetadata 由 adapter 在流结束时经 `response.auxiliary` 与 `AIResponse` 字段交付。`AuxiliaryCollector` 是 provider 内部实现细节，`0.5.0` 起不再从根入口导出。

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
