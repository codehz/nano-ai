/**
 * HTTP adapter 共享基类与构造选项
 *
 * 收敛五家真实后端 adapter 的：
 * - apiKey / baseUrl / fetch / headers / extraBody 字段赋值
 * - 默认 baseUrl 解析
 *
 * 应用代码应只实现 BackendAdapter；勿依赖本内部基类。
 */

import { AdapterBase } from "./base.js";
import { applyExtraBody, mergeProviderHeaders } from "./request-options.js";
import type { FetchFn } from "../types/index.js";

/** 真实 HTTP adapter 的公共构造选项；apiKey 由各 adapter 收紧或保持可选。 */
export type HttpAdapterOptions = {
  apiKey?: string;
  baseUrl?: string;
  /** 可注入自定义 fetch 实现（测试 / 代理） */
  fetch?: FetchFn;
  /** 额外请求头；后写覆盖内置鉴权 / Content-Type 等 */
  headers?: Record<string, string>;
  /** 额外 body 顶层字段；浅层合并，同名键可覆盖 */
  extraBody?: Record<string, unknown>;
};

export type HttpAdapterDefaults = {
  baseUrl: string;
};

/**
 * HTTP adapter 薄基类：统一字段与默认值。
 * stream session 脚手架见 beginJsonStream（阶段 2 接入）。
 */
export abstract class HttpAdapterBase extends AdapterBase {
  protected apiKey: string | undefined;
  protected baseUrl: string;
  protected fetchFn: FetchFn;
  protected headers: Record<string, string> | undefined;
  protected extraBody: Record<string, unknown> | undefined;

  constructor(options: HttpAdapterOptions, defaults: HttpAdapterDefaults) {
    super();
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? defaults.baseUrl;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.headers = options.headers;
    this.extraBody = options.extraBody;
  }

  /** 合并内置 headers 与构造期自定义 headers。 */
  protected mergeHeaders(base: Record<string, string>): Record<string, string> {
    return mergeProviderHeaders(base, this.headers);
  }

  /** 将构造期 extraBody 浅层合并进已构建 body。 */
  protected withExtraBody<T extends object>(body: T): T {
    return applyExtraBody(body, this.extraBody);
  }
}
