/**
 * Adapter 抽象基类
 *
 * 约定 adapter 的内部职责分层（build / invoke / parse / emit）：
 * 1. buildRequest    — 将 NormalizedRequest 转换为 provider 请求格式
 * 2. invokeProvider  — 调用 provider API
 * 3. parseResponse   — 解析 provider 响应为 canonical 中间态
 * 4. emitEvents      — 产出 canonical 事件流
 *
 * 子类实现 buildRequest() 和 runStream()，
 * runStream 返回 AsyncIterable，事件实时发射给消费者。
 */

import type {
  NormalizedRequest,
  BackendAdapter,
  AdapterCapabilities,
  AIStreamEvent,
  AIResponse,
  OutputItem,
  ReplayItem,
  StopReason,
  Usage,
  BillingInfo,
  ToolCallItem,
} from "../types/index.js";
import { createEventFactory } from "../core/event-factory.js";
import type { EventFactory } from "../core/event-factory.js";
import { extractText } from "./mapping.js";

// ── Adapter 解析中间结果 ──────────────────────────────────────

export type ProviderResponse = unknown;

/**
 * adapter 完成一轮处理后返回的最终结果。
 * 用于 buildResponse() 构建 AIResponse。
 */
export type StreamResult = {
  output: OutputItem[];
  replay: ReplayItem[];
  stopReason?: StopReason;
  usage?: Usage;
  billing?: BillingInfo;
  providerMetadata?: Record<string, unknown>;
  rawResponseId?: string;
};

// ── 抽象基类 ──────────────────────────────────────────────────

export abstract class AdapterBase implements BackendAdapter {
  abstract readonly kind: "chat-completions" | "messages" | "responses" | "ollama";
  abstract readonly capabilities: AdapterCapabilities;

  /**
   * stream 模板方法：
   * 1. 创建事件工厂，发射 response.started
   * 2. 构建 provider 请求
   * 3. 委托 runStream 发射全部流事件（含 response.completed）
   */
  async *stream(request: NormalizedRequest): AsyncIterable<AIStreamEvent> {
    const factory = createEventFactory({
      responseId: request.requestId,
      backend: { kind: this.kind, isSynthetic: !this.capabilities.nativeStreaming },
    });

    yield factory.responseStarted(request.model);

    try {
      const providerRequest = await this.buildRequest(request);
      yield* this.runStream(providerRequest, factory, request);
    } catch (err) {
      yield factory.responseWarning(err instanceof Error ? err.message : String(err), "PROVIDER_ERROR");
      yield factory.responseCompleted(this.buildResponse(request, { output: [], replay: [] }, factory));
    }
  }

  // ── 子类必须实现 ──────────────────────────────────────────

  /** 将 NormalizedRequest 转换为 provider 请求格式。 */
  protected abstract buildRequest(request: NormalizedRequest): ProviderResponse | Promise<ProviderResponse>;

  /**
   * 执行流式请求，发射全部事件（含 response.completed）。
   * 子类负责：
   * - 调用 provider
   * - 解析每个 chunk
   * - 通过 factory 发射 item 事件
   * - 构建 StreamResult
   * - 发射 factory.responseCompleted(buildResponse(…))
   */
  protected abstract runStream(
    providerRequest: ProviderResponse,
    factory: EventFactory,
    request: NormalizedRequest,
  ): AsyncIterable<AIStreamEvent>;

  // ── 共享构造方法 ──────────────────────────────────────────

  /**
   * 从 StreamResult 构建完整 AIResponse。
   * 子类可在返回前自定义覆盖。
   */
  protected buildResponse(request: NormalizedRequest, result: StreamResult, _factory: EventFactory): AIResponse {
    const text = this.extractText(result.output);

    return {
      id: request.requestId,
      output: result.output,
      replay: result.replay,
      text,
      toolCalls: result.output.filter((item): item is ToolCallItem => item.type === "tool_call"),
      stopReason: result.stopReason,
      usage: result.usage,
      billing: result.billing,
      auxiliary: result.providerMetadata ? { providerMetadata: result.providerMetadata } : undefined,
      backend: {
        requestId: request.requestId,
        rawResponseId: result.rawResponseId,
        adapter: this.kind,
        isSyntheticStream: !this.capabilities.nativeStreaming,
      },
    };
  }

  /** 从 output items 中提取文本内容。 */
  protected extractText(output: OutputItem[]): string {
    return extractText(output);
  }
}
