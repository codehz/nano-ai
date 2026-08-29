/**
 * 上下文压缩能力接口
 *
 * 仅由原生支持压缩的 adapter 实现；不扩展 BackendAdapter / AIClient。
 * 调用方通过 supportsContextCompress 做能力探测。
 */

import type { InstructionBlock } from "./content.js";
import type { InputItem, ReplayItem } from "./items.js";
import type { IncludeSettings } from "./request.js";
import type { AuxiliaryInfo, Usage } from "./response.js";
import type { BackendAdapter } from "./adapter.js";

/** 显式上下文压缩请求（独立于 stream）。 */
export type CompressRequest = {
  model: string;
  input: InputItem[];
  instructions?: string | InstructionBlock[];
  include?: IncludeSettings;
  /** AbortSignal 用于打断压缩请求。 */
  signal?: AbortSignal;
};

/** 压缩结果；调用方用 replay 替换旧 transcript，而不是追加全文。 */
export type CompressResult = {
  replay: ReplayItem[];
  usage?: Usage;
  auxiliary?: AuxiliaryInfo;
  rawResponseId?: string;
};

/** Adapter 可选的原生上下文压缩能力。 */
export interface ContextCompressCapable {
  compress(request: CompressRequest): Promise<CompressResult>;
}

/** 探测 adapter 是否实现上下文压缩能力。 */
export function supportsContextCompress(adapter: BackendAdapter): adapter is BackendAdapter & ContextCompressCapable {
  return typeof (adapter as Partial<ContextCompressCapable>).compress === "function";
}
