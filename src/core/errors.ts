/**
 * 公共错误类型（最小集合）
 *
 * Phase 10 将在此之上扩展完整的错误模型。
 */

export class AIRequestError extends Error {
  override readonly name = "AIRequestError";

  constructor(message: string, public readonly code: string) {
    super(message);
  }
}
