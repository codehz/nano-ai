/**
 * 辅助信息采集器 (AuxiliaryCollector)
 *
 * 为 usage、billing、providerMetadata 提供统一的 best-effort 采集。
 *
 * 采集优先级（分层）：
 *   1. 主响应 body / terminal event
 *   2. headers / trailers
 *   3. SDK metadata
 *   4. 一次 follow-up lookup
 *   5. derived estimate
 *
 * 约束：
 *   - lookup 最多一次有界补查
 *   - lookup 失败只记录 warning
 *   - 不阻断主生成链路
 */

import type { Usage, BillingInfo, AuxiliaryInfo, StreamWarning } from "../types/index.js";

// ── 来源类型 ──────────────────────────────────────────────────

export type UsageSource = NonNullable<AuxiliaryInfo["usageSource"]>;
export type BillingSource = NonNullable<AuxiliaryInfo["billingSource"]>;

export type LookupResult = {
  usage?: Partial<Usage>;
  billing?: Partial<BillingInfo>;
  providerMetadata?: Record<string, unknown>;
};

// ── Collector ─────────────────────────────────────────────────

export class AuxiliaryCollector {
  private usage: Partial<Usage> = {};
  private usageSource: UsageSource | undefined;
  private billing: Partial<BillingInfo> | undefined;
  private billingSource: BillingSource | undefined;
  private providerMetadata: Record<string, unknown> = {};
  private providerUsage: unknown;
  private providerBilling: unknown;
  private warnings: StreamWarning[] = [];
  private lookupAttempted = false;

  // ── 记录方法 ──────────────────────────────────────────────

  /**
   * 记录 usage 信息。
   * 后调用的覆盖先调用的（优先级由调用方控制）。
   */
  recordUsage(usage: Partial<Usage>, source: UsageSource, raw?: unknown): this {
    this.usage = { ...this.usage, ...usage };
    this.usageSource = source;
    if (raw !== undefined) this.providerUsage = raw;
    return this;
  }

  /**
   * 记录 billing 信息。
   * 后调用的覆盖先调用的。
   */
  recordBilling(billing: Partial<BillingInfo>, source: BillingSource, raw?: unknown): this {
    this.billing = { ...this.billing, ...billing };
    this.billingSource = source;
    if (raw !== undefined) this.providerBilling = raw;
    return this;
  }

  /**
   * 记录 provider 元数据（非 canonical 的 key-value 信息）。
   */
  recordMetadata(metadata: Record<string, unknown>): this {
    this.providerMetadata = { ...this.providerMetadata, ...metadata };
    return this;
  }

  /**
   * 记录一条 warning。
   */
  recordWarning(message: string, code?: StreamWarning["code"]): this {
    this.warnings.push({ message, ...(code !== undefined ? { code } : {}) });
    return this;
  }

  // ── 有界 Lookup ───────────────────────────────────────────

  /**
   * 执行一次有界 follow-up lookup。
   * 最多调用一次；后续调用被忽略。
   * lookup 失败（抛错）仅记录 warning，不传播异常。
   */
  async tryLookup(lookupFn: () => Promise<LookupResult>, timeoutMs = 5_000): Promise<void> {
    if (this.lookupAttempted) return;
    this.lookupAttempted = true;

    try {
      const result = await withTimeout(lookupFn(), timeoutMs);
      if (result.usage) {
        this.recordUsage(result.usage, "lookup", result.usage);
      }
      if (result.billing) {
        const bill: Partial<BillingInfo> = {
          ...result.billing,
          source: result.billing?.source ?? "lookup",
        };
        this.recordBilling(bill, "lookup", result.billing);
      }
      if (result.providerMetadata) {
        this.recordMetadata(result.providerMetadata);
      }
    } catch (err) {
      this.recordWarning(`Auxiliary lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 构建最终结果 ──────────────────────────────────────────

  /**
   * 构建最终的 usage / billing / auxiliary。
   * 所有字段均为可选的 — 拿不到就不给。
   */
  build(): { usage?: Usage; billing?: BillingInfo; auxiliary?: AuxiliaryInfo; warnings?: StreamWarning[] } {
    const result: {
      usage?: Usage;
      billing?: BillingInfo;
      auxiliary?: AuxiliaryInfo;
      warnings?: StreamWarning[];
    } = {};

    if (Object.keys(this.usage).length > 0) {
      result.usage = this.usage as Usage;
    }

    if (this.billing) {
      result.billing = this.billing as BillingInfo;
    }

    const aux: AuxiliaryInfo = {};
    if (this.usageSource) aux.usageSource = this.usageSource;
    if (this.billingSource) aux.billingSource = this.billingSource;
    if (this.providerUsage !== undefined) aux.providerUsage = this.providerUsage;
    if (this.providerBilling !== undefined) aux.providerBilling = this.providerBilling;
    if (Object.keys(this.providerMetadata).length > 0) aux.providerMetadata = this.providerMetadata;

    if (Object.keys(aux).length > 0) {
      result.auxiliary = aux;
    }

    if (this.warnings.length > 0) {
      result.warnings = [...this.warnings];
    }

    return result;
  }

  /**
   * 已使用的来源列表（用于 debugging）。
   */
  get sources(): { usage?: UsageSource; billing?: BillingSource } {
    return { usage: this.usageSource, billing: this.billingSource };
  }
}

// ── Helper ────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Lookup timed out after ${ms}ms`)), ms)),
  ]);
}
