import { WarningCode } from "../core/errors.js";
import type { EventFactory } from "../core/event-factory.js";
import type {
  AdapterCapabilities,
  AIStreamEvent,
  BillingInfo,
  NormalizedRequest,
  Usage,
  AuxiliaryInfo,
  BackendTrace,
} from "../types/index.js";
import { AuxiliaryCollector, type BillingSource, type LookupResult, type UsageSource } from "./auxiliary-collector.js";

type MaybePromise<T> = T | Promise<T>;

export type BillingPostprocessHook = (context: {
  request: NormalizedRequest;
  usage?: Usage;
  billing?: BillingInfo;
  auxiliary?: AuxiliaryInfo;
  capabilities: AdapterCapabilities;
}) => MaybePromise<Partial<BillingInfo> | undefined>;

export type AuxiliaryFinalizeOptions = {
  lookup?: () => Promise<LookupResult>;
  lookupTimeoutMs?: number;
  postprocessBilling?: BillingPostprocessHook;
  postprocessBillingSource?: BillingSource;
};

export type AuxiliaryFinalizeResult = {
  events: AIStreamEvent[];
  usage?: Usage;
  billing?: BillingInfo;
  auxiliary?: AuxiliaryInfo;
  warnings?: string[];
  metadataSources?: string[];
};

export class AdapterAuxiliaryState {
  private readonly collector = new AuxiliaryCollector();
  private readonly metadataSources = new Set<string>();

  constructor(
    private readonly request: NormalizedRequest,
    private readonly capabilities: AdapterCapabilities,
  ) {}

  recordUsage(usage: Partial<Usage>, source: UsageSource, raw?: unknown): void {
    if (this.request.include?.usage === "off" || isEmptyRecord(usage)) return;
    this.collector.recordUsage(usage, source, raw);
  }

  recordBilling(billing: Partial<BillingInfo>, source: BillingSource, raw?: unknown): void {
    if (this.request.include?.billing === "off" || isEmptyRecord(billing)) return;
    this.collector.recordBilling(billing, source, raw);
  }

  recordProviderMetadata(source: string, metadata: Record<string, unknown> | undefined): void {
    if (this.request.include?.providerMetadata === "off" || !metadata || isEmptyRecord(metadata)) return;
    this.collector.recordMetadata(metadata);
    this.metadataSources.add(source);
  }

  async finalize(factory: EventFactory, options: AuxiliaryFinalizeOptions = {}): Promise<AuxiliaryFinalizeResult> {
    if (options.lookup && this.shouldAttemptLookup()) {
      await this.collector.tryLookup(options.lookup, options.lookupTimeoutMs);
    }

    if (this.request.include?.billing !== "off" && options.postprocessBilling) {
      const snapshot = this.collector.build();
      if (!snapshot.billing) {
        const derived = await options.postprocessBilling({
          request: this.request,
          usage: snapshot.usage,
          billing: snapshot.billing,
          auxiliary: snapshot.auxiliary,
          capabilities: this.capabilities,
        });
        if (derived && !isEmptyRecord(derived)) {
          this.collector.recordBilling(
            {
              ...derived,
              isEstimated: derived.isEstimated ?? true,
              source: derived.source ?? "derived",
            },
            options.postprocessBillingSource ?? "derived",
            derived,
          );
        }
      }
    }

    const built = this.collector.build();
    const events: AIStreamEvent[] = [];

    if (built.usage || built.billing || built.auxiliary) {
      events.push(
        factory.responseAuxiliary({
          usage: built.usage,
          billing: built.billing,
          auxiliary: built.auxiliary,
        }),
      );
    }

    if (this.request.include?.usage !== "off" && !built.usage) {
      events.push(factory.responseWarning("Usage information was not provided by the provider", WarningCode.USAGE_MISSING));
    }

    if (this.request.include?.billing !== "off") {
      if (!built.billing) {
        events.push(
          factory.responseWarning("Billing information was not provided by the provider", WarningCode.BILLING_MISSING),
        );
      } else if (built.billing.isEstimated) {
        events.push(factory.responseWarning("Billing amount is an estimate", WarningCode.BILLING_ESTIMATED));
      }
    }

    return {
      events,
      usage: built.usage,
      billing: built.billing,
      auxiliary: built.auxiliary,
      warnings: built.warnings,
      metadataSources: this.metadataSources.size > 0 ? [...this.metadataSources] : undefined,
    };
  }

  private shouldAttemptLookup(): boolean {
    if (
      this.request.include?.usage === "off" &&
      this.request.include?.billing === "off" &&
      this.request.include?.providerMetadata === "off"
    ) {
      return false;
    }

    const snapshot = this.collector.build();
    return (
      (this.request.include?.usage !== "off" && !snapshot.usage) ||
      (this.request.include?.billing !== "off" && !snapshot.billing) ||
      (this.request.include?.providerMetadata !== "off" && !snapshot.auxiliary?.providerMetadata)
    );
  }
}

export function emitMalformedStreamWarning(
  factory: EventFactory,
  options: {
    count: number;
    providerLabel: string;
    transportLabel: string;
  },
): AIStreamEvent | undefined {
  if (options.count < 1) return undefined;
  return factory.responseWarning(
    `Skipped ${options.count} malformed ${options.providerLabel} ${options.transportLabel}`,
    "STREAM_ERROR",
  );
}

export function metadataSourceList(
  ...groups: Array<Array<NonNullable<BackendTrace["metadataSources"]>[number]> | undefined>
): string[] | undefined {
  const sources = new Set<string>();

  for (const group of groups) {
    if (!group) continue;
    for (const source of group) {
      sources.add(source);
    }
  }

  return sources.size > 0 ? [...sources] : undefined;
}

function isEmptyRecord(value: object): boolean {
  return Object.keys(value).length === 0;
}
