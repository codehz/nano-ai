/**
 * BackendAdapter — adapter 内部协议和 client 公开类型
 *
 * adapter 对前台只暴露一个统一适配点。
 */

import type { AIRequest } from "./request.js";
import type { AIStreamEvent } from "./events.js";
import type { AdapterKind } from "./kind.js";

// ── 公共工具类型 ──────────────────────────────────────────────

/** HTTP fetch 函数签名，用于注入自定义请求实现（测试／代理）。 */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

// ── 归一化请求 ────────────────────────────────────────────────

/** 经过模型选择和默认值合并后的请求。 */
export type NormalizedRequest = AIRequest & {
  model: string;
  requestId: string;
};

// ── Adapter 接口 ──────────────────────────────────────────────
/** AI 后端适配器必须实现的统一流式协议。 */
export interface BackendAdapter {
  readonly kind: AdapterKind;
  readonly isSyntheticStream: boolean;
  stream(request: NormalizedRequest): AsyncIterable<AIStreamEvent>;
}

// ── Client 公开类型 ───────────────────────────────────────────

/** createAIClient 的配置。 */
export type CreateAIClientOptions = {
  adapter: BackendAdapter;
  model: string;
  defaults?: Partial<AIRequest>;
  /** 全局默认 AbortSignal，当 request.signal 未设置时生效。 */
  signal?: AbortSignal;
};

/** 面向调用方的统一 AI 客户端。 */
export interface AIClient {
  stream(request: AIRequest): AsyncIterable<AIStreamEvent>;
}
