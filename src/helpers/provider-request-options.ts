/**
 * Provider 请求 headers / body 扩展合并
 *
 * 供真实后端 adapter 构造选项 `headers` / `extraBody` 使用：
 * - headers：内置鉴权头为基，自定义后写覆盖
 * - extraBody：已构建 body 为基，额外字段浅层 spread，同名顶层键可覆盖
 */

/** 合并内置 headers 与自定义 headers；自定义后写覆盖同名键。 */
export function mergeProviderHeaders(
  base: Record<string, string>,
  custom?: Record<string, string>,
): Record<string, string> {
  if (!custom) return base;
  return { ...base, ...custom };
}

/**
 * 将构造期 extraBody 浅层合并到已构建的 provider body。
 * 无 extraBody 时原样返回；有则允许覆盖同名顶层键。
 */
export function applyExtraBody<T extends object>(body: T, extraBody?: Record<string, unknown>): T {
  if (!extraBody) return body;
  return { ...body, ...extraBody };
}
