/**
 * Adapter 抽象基类
 *
 * 约定 adapter 的内部职责分层（build / invoke / parse / emit）：
 * 1. buildRequest    — 将 NormalizedRequest 转换为 provider 请求格式
 * 2. invokeProvider  — 调用 provider API
 * 3. parseResponse   — 解析 provider 响应为 canonical 中间态
 * 4. emitEvents      — 产出 canonical 事件流
 *
 * 子类只需实现 buildRequest() 和 runStream()，
 * 共享的事件创建、warnings 跟踪、final response 构建由基类完成。
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
} from "../types/index.js";
import { createEventFactory } from "../core/event-factory.js";
import type { EventFactory } from "../core/event-factory.js";

// ── Adapter 解析中间结果 ──────────────────────────────────────

export type ProviderStreamChunk = unknown;
export type ProviderResponse = unknown;

/**
 * adapter 完成一轮流式处理后返回的结果。
 * 子类在 runStream 中填充此对象。
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
  abstract readonly kind: "chat-completions" | "messages" | "responses";
  abstract readonly capabilities: AdapterCapabilities;

  /**
   * stream 模板方法：
   * 1. 创建事件工厂
   * 2. 发射 response.started
   * 3. 构建 provider 请求并运行流
   * 4. 发射 response.auxiliary（如有）
   * 5. 构建 final response 并发射 response.completed
   */
  async *stream(request: NormalizedRequest): AsyncIterable<AIStreamEvent> {
    const factory = createEventFactory({
      responseId: request.requestId,
      backend: { kind: this.kind, isSynthetic: !this.capabilities.nativeStreaming },
    });

    yield factory.responseStarted(request.model);

    let result: StreamResult;

    try {
      const providerRequest = await this.buildRequest(request);
      result = await this.runStream(providerRequest, factory);
    } catch (err) {
      yield factory.responseWarning(
        err instanceof Error ? err.message : String(err),
        "PROVIDER_ERROR",
      );
      // 仍然尝试给出一个空的 completed，避免调用方无端挂起
      result = {
        output: [],
        replay: [],
      };
    }

    // 如果有辅助信息且在 runStream 中已收集，发射 auxiliary 事件
    if (result.usage || result.billing) {
      yield factory.responseAuxiliary({
        usage: result.usage,
        billing: result.billing,
      });
    }

    // 构建并发射最终 response
    const response = this.buildResponse(request, result, factory);
    yield factory.responseCompleted(response);
  }

  // ── 子类必须实现 ──────────────────────────────────────────

  /**
   * 将 NormalizedRequest 转换为 provider 请求格式。
   */
  protected abstract buildRequest(request: NormalizedRequest): ProviderResponse | Promise<ProviderResponse>;

  /**
   * 执行流式请求，使用事件工厂发射事件，填充 StreamResult。
   * 子类在此方法内：
   * - 调用 provider
   * - 解析每个 chunk
   * - 通过 factory 发射事件
   * - 收集 output / replay / usage 等
   */
  protected abstract runStream(
    providerRequest: ProviderResponse,
    factory: EventFactory,
  ): StreamResult | Promise<StreamResult>;

  // ── 共享构造方法 ──────────────────────────────────────────

  /**
   * 从 StreamResult 构建完整 AIResponse。
   * 子类可在返回前自定义覆盖。
   */
  protected buildResponse(
    request: NormalizedRequest,
    result: StreamResult,
    _factory: EventFactory,
  ): AIResponse {
    const text = this.extractText(result.output);

    return {
      id: request.requestId,
      output: result.output,
      replay: result.replay,
      text,
      toolCalls: result.output.filter(
        (item): item is import("../types/index.js").ToolCallItem => item.type === "tool_call",
      ),
      stopReason: result.stopReason,
      usage: result.usage,
      billing: result.billing,
      auxiliary: result.providerMetadata
        ? { providerMetadata: result.providerMetadata }
        : undefined,
      backend: {
        requestId: request.requestId,
        rawResponseId: result.rawResponseId,
        adapter: this.kind,
        isSyntheticStream: !this.capabilities.nativeStreaming,
      },
    };
  }

  /**
   * 从 output items 中提取文本内容。
   */
  protected extractText(output: OutputItem[]): string {
    return output
      .filter((item): item is import("../types/index.js").MessageItem => item.type === "message")
      .flatMap((m) => m.content)
      .filter(
        (b): b is import("../types/index.js").ContentBlock & { type: "text" } => b.type === "text",
      )
      .map((b) => b.text)
      .join("");
  }
}
