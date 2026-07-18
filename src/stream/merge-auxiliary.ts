import type { AuxiliaryInfo } from "../types/index.js";

export function mergeAuxiliary(
  base?: Partial<AuxiliaryInfo>,
  patch?: Partial<AuxiliaryInfo>,
): AuxiliaryInfo | undefined {
  if (!base && !patch) return undefined;

  const merged: AuxiliaryInfo = {
    ...base,
    ...patch,
  };

  if (base?.providerMetadata || patch?.providerMetadata) {
    merged.providerMetadata = {
      ...base?.providerMetadata,
      ...patch?.providerMetadata,
    };
  }

  return merged;
}
