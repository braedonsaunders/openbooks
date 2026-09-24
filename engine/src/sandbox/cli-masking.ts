import type { SandboxTier } from "./clone.ts";

/** Refuse a CLI masking flag that contradicts the selected sandbox tier. */
export function resolveCreateMasking(tier: SandboxTier, maskedFlag: string | undefined): boolean {
  const tierMasked = tier === "masked";
  if (maskedFlag !== undefined) {
    const wantsMasked = maskedFlag !== "false";
    if (wantsMasked !== tierMasked) {
      throw new Error(
        wantsMasked
          ? `--masked=true requires --tier=masked: a ${tier}-tier clone carries live production data unmasked. Drop --masked or switch to --tier=masked`
          : `--masked=false contradicts --tier=masked: the masked tier always scrubs PII. Drop --masked=false or choose a different tier`,
      );
    }
    return wantsMasked;
  }
  return tierMasked;
}
