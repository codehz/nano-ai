# nano-ai 实现计划

## 文档目的

本文档基于 [design.md](/home/codehz/Projects/nano-ai/docs/design.md) 的统一流式 API 设计，给出一份可直接落地的多步骤实现计划。

目标不是重复设计结论，而是明确：

- 先做什么，后做什么
- 每一步的交付物是什么
- 哪些能力必须先稳定，哪些可以后补
- 如何判断当前阶段已经完成

## 当前仓库状态

当前仓库仍处于初始化状态：

- 入口文件仍为 Bun 默认脚手架
- 尚未建立 `src/` 目录和库结构
- 尚未落任何 canonical type、adapter、聚合器或测试

因此本计划默认按“从零开始实现库内核”编排。

## 实现目标

v1 实现目标如下：

1. 对外只暴露一个 canonical 主入口：`client.stream()`
2. 请求、事件、响应、replay 均有稳定的 TypeScript 类型
3. 支持三类后端 adapter：`responses`、`messages`、`chat.completions`
4. 原生流式与非原生流式后端都统一产出 `AsyncIterable<AIStreamEvent>`
5. 流结束时可稳定聚合为 `AIResponse`
6. `replay` 由 adapter 显式提供，支持下游自行做多轮和工具循环
7. `usage`、`billing`、`provider metadata` 按 `best-effort` 采集

## 非目标

本阶段明确不做以下内容：

- `session()` 或托管式会话接口
- 自动工具执行
- 自动 agent loop
- 自动上下文裁剪
- 为流式再设计一套独立的公开非流式协议
- 抽象 provider 专有托管工具生态

## 总体实施顺序

1. 建立项目骨架和公开 API 边界
2. 落 canonical 类型系统
3. 实现请求归一化和客户端入口
4. 实现统一事件工具和流聚合器
5. 定义 adapter 内部协议
6. 先打通 `responses` adapter
7. 再补 `messages` adapter
8. 最后补 `chat.completions` adapter
9. 加入模拟流式与辅助信息采集层
10. 完成测试矩阵、示例和文档

## 阶段计划

### Phase 0: 项目骨架

目标：把仓库从 Bun 初始化脚手架整理成可持续开发的库结构。

任务：

- 新建 `src/` 目录
- 规划模块边界：
  - `src/types/`
  - `src/core/`
  - `src/adapters/`
  - `src/helpers/`
  - `src/testing/` 或 `tests/`
- 建立统一导出入口
- 配置基础开发命令：
  - 类型检查
  - 测试
  - 示例运行

交付物：

- 清晰的目录结构
- 统一入口文件
- 可执行的开发脚本

验收标准：

- 仓库不再依赖单文件入口
- 可以通过一个固定命令完成类型检查
- 可以通过一个固定命令执行测试

#### Phase 0 实施结果 ✅

**完成状态：** 已完成 (2026-07-07)

**关键修改文件：**

| 操作 | 文件 |
|------|------|
| 新建 | `src/types/index.ts` — 类型系统模块边界 |
| 新建 | `src/core/index.ts` + `src/core/client.ts` — 核心运行时模块边界 + AIClient 桩 |
| 新建 | `src/adapters/index.ts` — adapter 模块边界 |
| 新建 | `src/helpers/index.ts` — helper 模块边界 |
| 新建 | `src/index.ts` — 统一导出入口 |
| 修改 | `package.json` — 入口指向 `src/index.ts`，新增 `typecheck`/`test`/`example:basic` 脚本 |
| 修改 | `index.ts` — 改为重新导出 `src/index.ts` |
| 新建 | `tests/index.test.ts` — 首个骨架测试 |
| 新建 | `examples/basic.ts` — 基础示例 |

**验证结果：**

- `bun run typecheck` — 通过（无错误）
- `bun run test` — 通过（1 test, 1 pass）
- `bun run example:basic` — 通过（导入链路正常）

**备注：**

- `createAIClient()` 为 Phase 2 桩实现，目前仅保证导入编译通过
- 测试使用 `bun:test`，已随 Bun 内置，无需额外安装测试框架

### Phase 1: Canonical 类型系统

目标：把设计文档中的统一请求、事件、响应模型固化为代码。

任务：

- 定义 `AIRequest`
- 定义 `InputItem`、`OutputItem`、`ReplayItem`
- 定义 `MessageItem`、`ReasoningItem`、`ToolCallItem`、`ToolResultItem`、`OpaqueItem`
- 定义 `ContentBlock`
- 定义 `Usage`、`BillingInfo`、`AuxiliaryInfo`、`BackendTrace`
- 定义 `AIStreamEvent` 及各事件子类型
- 定义 `AIResponse`
- 定义 `BackendAdapter`、`AdapterCapabilities`、`NormalizedRequest`
- 把能力矩阵落成常量或类型约束，而不是只保留在文档里

交付物：

- `src/types/` 下完整类型定义
- 类型导出入口
- 基础类型测试

验收标准：

- 所有核心公开概念都有稳定类型定义
- 无需接入真实 provider 即可编译通过
- 能力矩阵已进入代码，而非仅存在于文档

#### Phase 1 实施结果 ✅

**完成状态：** 已完成 (2026-07-07)

**关键修改文件：**

| 操作 | 文件 |
|------|------|
| 新建 | `src/types/content.ts` — `ContentBlock` 联合类型 |
| 新建 | `src/types/items.ts` — `MessageItem`、`ReasoningItem`、`ToolCallItem`、`ToolResultItem`、`OpaqueItem`、`InputItem`、`OutputItem`、`ReplayItem` |
| 新建 | `src/types/request.ts` — `AIRequest`、`ToolDefinition`、`ToolChoice`、`IncludeSettings` |
| 新建 | `src/types/response.ts` — `AIResponse`、`StopReason`、`Usage`、`BillingInfo`、`AuxiliaryInfo`、`BackendTrace` |
| 新建 | `src/types/events.ts` — 全部 13 类流事件类型 + `AIStreamEvent` 联合 |
| 新建 | `src/types/adapter.ts` — `BackendAdapter`、`AdapterCapabilities`、`NormalizedRequest`、`CreateAIClientOptions`、`AIClient`、`CAPABILITY_MATRIX` 常量 |
| 修改 | `src/types/index.ts` — 所有类型统一导出入口 |
| 修改 | `src/core/client.ts` — 更新为使用正式类型导入 |
| 修改 | `tests/index.test.ts` — 新增 31 个类型构造测试 |

**验证结果：**

- `bun run typecheck` — 通过（无错误）
- `bun run test` — 通过（31 tests, 31 pass, 45 expect calls）

**已覆盖的公开概念清单：**

`ContentBlock` · `MessageItem` · `ReasoningItem` · `ToolCallItem` · `ToolResultItem` · `OpaqueItem` · `InputItem` · `OutputItem` · `ReplayItem` · `AIRequest` · `ToolDefinition` · `ToolChoice` · `IncludeSettings` · `StopReason` · `Usage` · `BillingInfo` · `AuxiliaryInfo` · `BackendTrace` · `AIResponse` · `StreamEventBase` · `ResponseStartedEvent` · `ResponseWarningEvent` · `ResponseAuxiliaryEvent` · `ResponseCompletedEvent` · `MessageStartedEvent` · `MessageDeltaEvent` · `MessageCompletedEvent` · `ReasoningStartedEvent` · `ReasoningDeltaEvent` · `ReasoningCompletedEvent` · `ToolCallStartedEvent` · `ToolCallDeltaEvent` · `ToolCallCompletedEvent` · `AIStreamEvent` · `BackendAdapter` · `AdapterCapabilities` · `NormalizedRequest` · `CreateAIClientOptions` · `AIClient` · `CAPABILITY_MATRIX`

**备注：**

- 能力矩阵 `CAPABILITY_MATRIX` 已落代码，三类后端的差异通过 `AdapterCapabilities` 类型和常量值显式建模
- `createAIClient()` 仍为桩，待 Phase 2 实现
- 测试侧重于类型构造，确保所有公开类型可被用户正确实例化
- 聚合器、事件工厂等运行时实现留待 Phase 3

### Phase 2: 客户端入口与请求归一化

目标：打通 `createAIClient()` 到 adapter 调用之间的公共入口。

任务：

- 实现 `createAIClient({ adapter, model, defaults })`
- 实现 `client.stream(request)`
- 实现 `defaults` 与请求参数合并
- 生成 `requestId`
- 填充 `include` 默认值
- 增加基础参数校验：
  - `input` 非空约束
  - `temperature`、`maxOutputTokens` 的基础合法性
  - `toolChoice` 与 `tools` 的一致性检查

交付物：

- 客户端入口实现
- `normalizeRequest()` 或等效模块
- 公共请求校验逻辑

验收标准：

- 调用方可以创建 client 并触发 adapter
- 默认值合并和请求归一化行为稳定
- 非法请求在进入 adapter 前即报错

#### Phase 2 实施结果 ✅

**完成状态：** 已完成 (2026-07-07)

**关键修改文件：**

| 操作 | 文件 |
|------|------|
| 新建 | `src/core/errors.ts` — `AIRequestError` 错误类型 |
| 新建 | `src/core/validation.ts` — `validateRequest()` + `assertValidRequest()` |
| 新建 | `src/core/normalize.ts` — `normalizeRequest()` 归一化实现 |
| 修改 | `src/core/client.ts` — `createAIClient()` 完整实现 |
| 修改 | `src/core/index.ts` — 导出新模块 |
| 新建 | `tests/core.test.ts` — 31 个核心单元测试 |

**验证结果：**

- `bun run typecheck` — 通过（无错误）
- `bun run test` — 通过（62 tests, 62 pass, 89 expect calls）

**验收标准对照：**

1. ✅ 调用方可以创建 client 并触发 adapter — `createAIClient()` 返回 `AIClient`，`stream()` 同步调用 `adapter.stream(normalized)`
2. ✅ 默认值合并和请求归一化行为稳定 — `defaults` 浅合并，`include` 三级合并（默认值 → defaults → 请求），`requestId` 由 `crypto.randomUUID()` 生成
3. ✅ 非法请求在进入 adapter 前即报错 — `normalizeRequest` 内部调用 `assertValidRequest`，校验失败同步抛 `AIRequestError`

**校验覆盖的非法场景：**

- `input` 为空数组或未定义 → `INPUT_EMPTY`
- `input` 元素为非法值 → `INPUT_INVALID_ITEM`
- `temperature` 为 NaN → `TEMPERATURE_NOT_NUMBER`
- `temperature < 0` 或 `> 2` → `TEMPERATURE_OUT_OF_RANGE`
- `maxOutputTokens` 非整数或小于 1 → `MAX_OUTPUT_TOKENS_INVALID`
- `toolChoice: { type: "tool", name }` 但 `tools` 未定义 → `TOOL_CHOICE_NO_TOOLS`
- `toolChoice` 指定的 tool name 不在 `tools` 中 → `TOOL_CHOICE_UNKNOWN_TOOL`

### Phase 3: 事件工具与流聚合器

目标：建立统一事件生产和统一结果聚合能力。

任务：

- 实现共享事件工厂：
  - 统一 `sequence`
  - 统一 `timestamp`
  - 统一 `responseId`
  - 统一 `backend.kind` 和 `isSynthetic`
- 实现流聚合器
- 合并 `message.delta` 为完整 `MessageItem`
- 合并 `reasoning.delta` 为完整 `ReasoningItem`
- 合并 `tool_call.delta` 为完整 `ToolCallItem`
- 合并多次 `response.auxiliary` 补丁
- 生成最终 `AIResponse`
- 汇总 `response.text`
- 保持 `output` 顺序稳定

约束：

- 聚合器不能猜测 replay
- 聚合器不能伪造 reasoning
- 聚合器不能解释 opaque payload
- 最终 `response.completed` 形状必须统一

交付物：

- 事件工厂
- 内部聚合器
- 可选的 `collectStream()` helper

验收标准：

- 给定同一事件流，聚合结果稳定且可预测
- 中间 `auxiliary` 补丁能正确合并
- 未收到 `response.completed` 时不会伪造最终响应

#### Phase 3 实施结果 ✅

**完成状态：** 已完成 (2026-07-07)

**关键修改文件：**

| 操作 | 文件 |
|------|------|
| 新建 | `src/core/event-factory.ts` — `createEventFactory` 共享事件工厂 |
| 新建 | `src/core/aggregator.ts` — `aggregateEvents` 流聚合器 |
| 新建 | `src/core/collect-stream.ts` — `collectStream` 流收集 helper |
| 修改 | `src/core/index.ts` — 导出新模块 |
| 新建 | `tests/events-aggregator.test.ts` — 20 个事件/聚合器测试 |

**验证结果：**

- `bun run typecheck` — 通过（无错误）
- `bun run test` — 通过（82 tests, 82 pass, 141 expect calls）

**验收标准对照：**

1. ✅ 给定同一事件流，聚合结果稳定且可预测 — `aggregateEvents` 从事件流独立构建 output/text/toolCalls，结果仅依赖事件顺序和内容
2. ✅ 中间 `auxiliary` 补丁能正确合并 — 多次 `response.auxiliary` 事件的 usage/billing/auxiliary 字段通过展开合并
3. ✅ 未收到 `response.completed` 时不会伪造最终响应 — `aggregateEvents` 和 `collectStream` 在流末尾没有 `response.completed` 时抛错

**事件工厂覆盖的事件类型：**

`response.started` · `response.warning` · `response.auxiliary` · `response.completed` · `message.started` · `message.delta` · `message.completed` · `reasoning.started` · `reasoning.delta` · `reasoning.completed` · `tool_call.started` · `tool_call.delta` · `tool_call.completed`

**聚合器约束遵守情况：**

- `replay` 取自 `response.completed.response.replay`，聚合器不猜测
- `reasoning` 透传 adapter 信息，聚合器不伪造
- `opaque` payload 不解释
- output 按事件完成顺序稳定排列

### Phase 4: Adapter 内部协议

目标：在接真实后端前，先统一 adapter 的实现骨架，避免三个 adapter 演化成三套风格。

任务：

- 约定 adapter 的内部职责分层：
  - build request
  - invoke provider
  - parse provider payload
  - emit canonical events
- 提炼共享 helper：
  - message 映射
  - reasoning 映射
  - tool call 映射
  - stop reason 映射
  - warning 记录
- 定义 replay 生成接口，由 adapter 显式提供 replay 材料

交付物：

- adapter base types
- adapter helper 模块
- replay 构造约定

验收标准：

- 三个 adapter 可以共享公共骨架
- replay 责任明确归属于 adapter，而非聚合器

#### Phase 4 实施结果 ✅

**完成状态：** 已完成 (2026-07-07)

**关键修改文件：**

| 操作 | 文件 |
|------|------|
| 新建 | `src/helpers/mapping.ts` — 共享映射 helper（stop reason、content block、item 构造、replay 构造） |
| 新建 | `src/helpers/adapter-base.ts` — `AdapterBase` 抽象基类（build/invoke/parse/emit 四层约定） |
| 修改 | `src/helpers/index.ts` — 导出新模块 |
| 新建 | `tests/adapter-base.test.ts` — 28 个映射和基类测试 |

**验证结果：**

- `bun run typecheck` — 通过（无错误）
- `bun run test` — 通过（110 tests, 110 pass, 198 expect calls）

**验收标准对照：**

1. ✅ 三个 adapter 可以共享公共骨架 — `AdapterBase` 提供模板方法 `stream()`，子类只需实现 `buildRequest()` 和 `runStream()`
2. ✅ replay 责任明确归属于 adapter，而非聚合器 — `StreamResult.replay` 由子类在 `runStream()` 中填充，`replayFromOutput()` 提供默认实现；聚合器（`aggregateEvents`）只从 `response.completed` 读取 replay

**AdapterBase 内部职责分层：**

| 层 | 方法 | 职责 |
|---|---|---|
| build | `buildRequest(request)` | 将 `NormalizedRequest` 转换为 provider 请求格式 |
| invoke | `runStream(providerRequest, factory)` | 调用 provider 并驱动事件发射 |
| parse |（子类在 runStream 内自行处理）| 解析 provider chunk/response 为 canonical 中间态 |
| emit |（通过 factory 参数）| 使用 `EventFactory` 发射规范的 `AIStreamEvent` |

**共享映射 helper 清单：**

| 函数 | 用途 |
|---|---|
| `mapStopReason(providerReason)` | provider stop_reason → `StopReason` |
| `mapReasoningVisibility(hasThinking, hasRedacted)` | → `"full"\|"summary"\|"redacted"\|"opaque"` |
| `textBlock` / `jsonBlock` / `imageBlock` / `opaqueBlock` | `ContentBlock` 构造 |
| `messageItem` / `reasoningItem` / `toolCallItem` / `toolResultItem` / `opaqueItem` | Item 构造 |
| `replayFromOutput(output)` | output → replay 默认映射 |

### Phase 5: `responses` Adapter

目标：优先打通能力最强的后端，作为 canonical 模型的基准实现。

任务：

- 接入 `responses` 请求构造
- 映射原生流事件到 canonical 事件
- 支持消息流
- 支持 reasoning 流
- 支持工具调用流
- 生成高保真 replay
- 尽可能保留 provider continuation 材料到 `opaque` replay item
- 映射 stop reason
- 收集原生 usage / metadata

交付物：

- `responses` adapter
- 基准 fixtures
- 第一套端到端流测试

验收标准：

- 单轮文本输出可稳定消费
- reasoning 与 tool call 事件可被正确聚合
- `response.replay` 能表达续接所需材料

#### Phase 5 实施结果 ✅

**完成状态：** 已完成 (2026-07-07)

**关键修改文件：**

| 操作 | 文件 |
|------|------|
| 新建 | `src/adapters/responses.ts` — `ResponsesAdapter` 完整实现（SSE 解析、请求构造、事件映射） |
| 修改 | `src/helpers/adapter-base.ts` — 重构 `runStream` 返回 `AsyncIterable<AIStreamEvent>` 支持实时事件发射 |
| 修改 | `src/core/aggregator.ts` — `handleResponseCompleted` 增加 usage/billing 提取 |
| 修改 | `src/adapters/index.ts` — 导出 `ResponsesAdapter` |
| 新建 | `tests/responses-adapter.test.ts` — 15 个端到端测试（文本流、reasoning 流、tool_call 流、replay、请求构建、错误处理、集成） |

**验证结果：**

- `bun run typecheck` — 通过（无错误）
- `bun run test` — 通过（124 tests, 124 pass, 245 expect calls）

**验收标准对照：**

1. ✅ 单轮文本输出可稳定消费 — 多消息文本流测试通过，`collectStream` + 聚合器正确产出 `AIResponse`
2. ✅ reasoning 与 tool call 事件可被正确聚合 — reasoning 流、tool_call 流测试验证 item 顺序和内容正确
3. ✅ `response.replay` 能表达续接所需材料 — output → replay 映射 + `opaque` continuation item（含 provider response id）共同构成高保真 replay

**ResponsesAdapter 能力全景：**

| 能力 | 状态 |
|------|------|
| SSE 协议解析 | ✅ `parseSSE` 处理 event/data 行 |
| 消息流 (message.*) | ✅ started → delta → completed |
| 思维链流 (reasoning.*) | ✅ started → delta → completed |
| 工具调用流 (tool_call.*) | ✅ started → delta (arguments) → completed |
| 请求构建 (buildRequest) | ✅ message/reasoning/tool_call/tool_result/opaque → Responses API 格式 |
| Stop reason 推断 | ✅ 基于 output items 判断 end_turn / tool_call / max_output_tokens |
| Replay 构造 | ✅ `replayFromOutput()` + `opaque` continuation |
| Usage 采集 | ✅ 从 `response.completed` 提取 |
| 错误处理 | ✅ HTTP 错误 → warning + 空 completed；SSE error 事件 → warning |
| 可测试性 | ✅ 注入 `FetchFn` mock，无需真实 API key |

任务：

- 映射消息块到 canonical message
- 映射 thinking / summary / redacted thinking 到 canonical reasoning
- 映射 tool use 到 canonical tool call
- 把不能稳定 canonical 化但应保留的续接材料落到 `opaque`
- 在能力降级场景发出 warning

### Phase 6: `messages` Adapter

目标：补齐 Anthropic 风格 `messages` / `thinking` / `tool use` 映射。

任务：

- 映射消息块到 canonical message
- 映射 thinking / summary / redacted thinking 到 canonical reasoning
- 映射 tool use 到 canonical tool call
- 把不能稳定 canonical 化但应保留的续接材料落到 `opaque`
- 在能力降级场景发出 warning

交付物：

- `messages` adapter
- thinking 与 replay 相关测试
- 红线场景 warning 测试

验收标准：

- `messages` 后端输出可被统一消费
- reasoning 可见性标注正确
- replay fidelity 降级有显式 warning

#### Phase 6 实施结果 ✅

**完成状态：** 已完成 (2026-07-07)

**关键修改文件：**

| 操作 | 文件 |
|------|------|
| 新建 | `src/adapters/messages.ts` — `MessagesAdapter` 完整实现（SSE 解析、thinking/tool_use 映射、system prompt 合并） |
| 修改 | `src/helpers/mapping.ts` — `STOP_REASON_MAP` 增加 `tool_use` → `tool_call` 映射 |
| 修改 | `src/adapters/index.ts` — 导出 `MessagesAdapter` |
| 新建 | `tests/messages-adapter.test.ts` — 15 个端到端测试 |

**验证结果：**

- `bun run typecheck` — 通过（无错误）
- `bun run test` — 通过（138 tests, 138 pass, 301 expect calls）

**验收标准对照：**

1. ✅ `messages` 后端输出可被统一消费 — 文本消息流测试通过，`collectStream` + 聚合器正确产出 `AIResponse`
2. ✅ reasoning 可见性标注正确 — `thinking` → `"full"`，`redacted_thinking` → `"redacted"` 映射正确
3. ✅ replay 构造含 opaque continuation — `opaque` replay item 携带 assistant content 和 message ID

**MessagesAdapter 能力全景：**

| 能力 | 状态 |
|------|------|
| SSE 协议解析 | ✅ `parseMessagesSSE` 处理 8 类事件 |
| 文本消息流 | ✅ `content_block_start(text)` → `message.*` |
| 思维链流 (thinking) | ✅ `content_block_start(thinking)` → `reasoning.*`，visibility 为 `"full"` |
| 隐藏思维链 (redacted_thinking) | ✅ 一次性发射完整块，visibility 为 `"redacted"` |
| 工具调用流 (tool_use) | ✅ `input_json_delta` → `tool_call.delta` |
| 请求构建 (buildRequest) | ✅ message/tool_call/tool_result/reasoning → Messages API 格式 |
| System prompt 合并 | ✅ instructions + system/developer role → `system` 字段 |
| Stop reason 映射 | ✅ `end_turn` / `max_tokens` / `tool_use` → canonical |
| Replay 构造 | ✅ `replayFromOutput()` + `opaque` continuation（含 content blocks） |
| Usage 采集 | ✅ 从 `message_delta` 提取 |
| 错误处理 | ✅ HTTP 错误 → warning；SSE error 事件 → warning |

### Phase 7: `chat.completions` Adapter

目标：补齐弱能力兼容层。

任务：

- 映射文本输出到 canonical message
- 映射工具调用到 canonical tool call
- 对 reasoning 缺失做显式能力声明
- 处理 replay fidelity 较低的情况
- 在无法提供隐藏 reasoning replay 时发出 warning

交付物：

- `chat.completions` adapter
- 弱能力场景测试

验收标准：

- 旧式 chat completion 风格响应可被统一消费
- 文本和工具调用路径可稳定工作
- 能力缺口通过 capability 和 warning 明确暴露

#### Phase 7 实施结果 ✅

**完成状态：** 已完成 (2026-07-07)

**关键修改文件：**

| 操作 | 文件 |
|------|------|
| 新建 | `src/adapters/chat-completions.ts` — `ChatCompletionsAdapter` 完整实现（SSE 解析、tool_calls/function_call 映射） |
| 修改 | `src/adapters/index.ts` — 导出 `ChatCompletionsAdapter` |
| 新建 | `tests/chat-completions-adapter.test.ts` — 16 个弱能力场景测试 |

**验证结果：**

- `bun run typecheck` — 通过（无错误）
- `bun run test` — 通过（154 tests, 154 pass, 352 expect calls）

**验收标准对照：**

1. ✅ 旧式 chat completion 风格响应可被统一消费 — 文本 delta 流测试通过，单块/多块均正确聚合
2. ✅ 文本和工具调用路径可稳定工作 — `tool_calls` 和 `function_call`（legacy）两种格式均支持
3. ✅ 能力缺口通过 capability 和 warning 明确暴露 — `capabilities.reasoningStreaming=false`、`toolCallStreaming=false`；HTTP 错误、断流等场景发出 warning

**ChatCompletionsAdapter 能力全景：**

| 能力 | 状态 |
|------|------|
| SSE 解析 | ✅ `parseChatSSE` 处理 `data: {...}` 行 + `[DONE]` 终止符 |
| 文本消息流 | ✅ `delta.content` → `message.*` 事件 |
| 工具调用流 (tool_calls) | ✅ `delta.tool_calls` 数组 → `tool_call.*`，支持多工具并行累积 |
| 旧格式工具调用 (function_call) | ✅ `delta.function_call` → `tool_call.*` 事件 |
| 消息首块标识 | ✅ `delta.role="assistant"` 识别；无 role 时从首个 `delta.content` 自动创建 |
| 请求构建 | ✅ message/tool_call/tool_result/reasoning → Chat Completions 格式 |
| tool_choice 映射 | ✅ `"auto"` / `"none"` / `{ type: "tool", name }` |
| 断流保护 | ✅ 流未正常结束（无 finish_reason）时仍 emit warning + 部分 output |
| 能力声明 | `reasoningStreaming: false`, `toolCallStreaming: false`, `replayFidelity: "low"` |
| 错误处理 | ✅ HTTP 错误 → warning；不完整流 → warning + partial output |

### Phase 8: 模拟流式层

目标：让非原生流式后端也满足统一事件流语义。

任务：

- 实现 synthetic streaming helper
- 输入完整 provider 响应，输出规范事件序列
- 每个 item 只发一块完整 delta
- 保持 item 边界
- 保持后端原始顺序
- 不发明 reasoning
- 不改写工具参数

交付物：

- 通用模拟流式实现
- synthetic stream fixtures

验收标准：

- 非流式响应可以被包装成规范事件流
- 调用方只需面向同一 `AsyncIterable<AIStreamEvent>` 编程

### Phase 9: 辅助信息采集层

目标：为 `usage`、`billing`、`providerMetadata` 提供统一的 best-effort 采集策略。

任务：

- 实现分层采集优先级：
  - 主响应 body / terminal event
  - headers / trailers
  - SDK metadata
  - 一次 follow-up lookup
  - derived estimate
- 限制 lookup 为一次有界补查
- lookup 失败只记录 warning
- 统一填充：
  - `usage`
  - `billing`
  - `auxiliary`
  - `warnings`
- 标明来源字段：
  - `usageSource`
  - `billingSource`

交付物：

- 辅助信息 collector
- lookup 策略实现
- 采集与降级测试

验收标准：

- 主生成链路不被辅助信息采集阻断
- 能 canonical 化的字段进入统一结构
- 不能 canonical 化的字段保留 raw 出口

### Phase 10: 错误模型与中断语义

目标：把失败、降级、断流三类情况明确区分。

任务：

- 定义致命错误类型：
  - 请求构造失败
  - provider 调用失败
  - provider 流协议损坏
  - canonical 映射失败
- 定义 warning 记录方式
- 明确流中断语义：
  - 未完成时不产出最终 `AIResponse`
  - 不伪造 `response.completed`
- 为 replay fidelity 降级、usage 缺失、billing 缺失等非致命问题保留 warning 通道

交付物：

- 公共错误类型
- 错误测试
- 中断行为测试

验收标准：

- 调用方能明确区分正常完成和异常终止
- 非致命差异不会被误判为请求失败

### Phase 11: 测试矩阵

目标：建立覆盖统一抽象边界的测试体系，而不是只测各 provider happy path。

任务：

- 类型测试
- 单元测试：
  - 请求归一化
  - 事件工厂
  - 聚合器
  - synthetic stream
  - 辅助信息采集
- adapter 测试：
  - `responses`
  - `messages`
  - `chat.completions`
- 场景测试：
  - 单轮文本流
  - reasoning 流
  - 工具调用流
  - replay 回放
  - 手动工具循环
  - usage / billing 回填
  - 降级 warning
  - 中途断流

交付物：

- fixture 集
- golden event sequence 测试
- 端到端场景测试

验收标准：

- 三类 adapter 都有正向和降级测试
- replay 行为有明确回归保护
- 事件序列和最终响应都可 snapshot 或 golden 对比

### Phase 12: 文档与示例

目标：让最终仓库文档反映真实 API，而不是停留在设计文档层面。

任务：

- 更新 README
- 增加最少三类示例：
  - 单轮流式输出
  - 下游自己做多轮 replay
  - 手动工具循环
- 补 adapter 能力说明
- 补 warning / capability / replay 语义说明

交付物：

- README
- `examples/`
- 面向用户的使用说明

验收标准：

- 新用户只看 README 和示例即可完成首次接入
- 示例代码与真实公开 API 一致

## 建议里程碑

### M1: 内核落地

范围：

- Phase 0
- Phase 1
- Phase 2
- Phase 3

结果：

- 已有稳定的 canonical 类型、客户端入口、事件工厂和聚合器
- 还未要求接通所有真实后端

### M2: 基准后端打通

范围：

- Phase 4
- Phase 5

结果：

- `responses` adapter 成为首个可用实现
- 可以验证 canonical 模型是否足够承载强能力后端

### M3: 多后端兼容完成

范围：

- Phase 6
- Phase 7
- Phase 8

结果：

- 三类后端均可接入
- 非原生流式后端也能走统一事件协议

### M4: 生产可用性补齐

范围：

- Phase 9
- Phase 10
- Phase 11
- Phase 12

结果：

- 观测、错误、测试、文档齐备
- API 进入可公开试用状态

## 优先级

最高优先：

- canonical 类型系统
- 聚合器
- `responses` adapter

中优先：

- `messages` adapter
- 模拟流式
- 错误模型

后补优先：

- billing / lookup 完整性
- README 和示例打磨

## 风险与注意事项

1. 不能让聚合器反向决定 replay 结构。否则 adapter 责任会被污染，后续 provider 差异会失控。
2. 不能先做托管会话接口再回填单轮流式内核。否则公开 API 会过早固化错误的状态模型。
3. `chat.completions` 的弱能力必须显式建模，不能为了统一表面形状而伪造 reasoning。
4. 辅助信息采集必须是 best-effort，不能让 lookup 失败拖垮主链路。
5. synthetic stream 只能做协议兼容，不能做体验层面的逐 token 幻觉模拟。

## 开工建议

建议严格按以下顺序启动开发：

1. 先完成 Phase 0 到 Phase 3
2. 立即实现 `responses` adapter 验证核心抽象
3. 在 `responses` 跑通后再扩展 `messages` 与 `chat.completions`
4. 最后统一补齐辅助信息采集、错误处理、测试矩阵和文档

这个顺序的好处是：最早验证统一模型是否成立，最晚再处理兼容性和完整性问题，避免一开始就在弱能力后端上被迫妥协核心抽象。
