/**
 * 请求归一化
 *
 * 将 AIRequest + client 配置归一化为 NormalizedRequest，
 * 包括默认值合并、requestId 生成、include 默认值填充。
 */

import type { AIRequest, NormalizedRequest } from "../types/index.js";
// Requests are typed client-side; provider-specific mapping owns wire compatibility.

/** 请求归一化选项。 */
export type NormalizeOptions = {
  model: string;
  defaults?: Partial<AIRequest>;
};

const DEFAULT_INCLUDE = {
  usage: "best_effort" as const,
  billing: "best_effort" as const,
  providerMetadata: "best_effort" as const,
};
/**
 * 归一化请求：合并 defaults、填充 include 默认值并生成 requestId。
 */
export function normalizeRequest(request: AIRequest, options: NormalizeOptions): NormalizedRequest {
  const { model, defaults } = options;

  // 合并 defaults（浅合并，input/tools 由 request 完全覆盖）
  const merged: AIRequest = {
    ...defaults,
    ...request,
    include: {
      ...DEFAULT_INCLUDE,
      ...defaults?.include,
      ...request.include,
    },
  };

  return {
    ...merged,
    model,
    requestId: crypto.randomUUID(),
  };
}
