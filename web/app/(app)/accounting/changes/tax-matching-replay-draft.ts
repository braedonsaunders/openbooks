import type { TaxMatchingReplayInput } from "@openbooks/engine/src/tax-returns/asset-basis-policy.ts";
import type { TaxMatchingReplayPreview } from "@openbooks/engine/src/tax-returns/consolidated-matching-replay.ts";

/** Serialize the server's citations, never a period selection or a financial
 * calculation. Propose/apply independently revalidate these same references. */
export function prepareTaxMatchingReplay(
  preview: TaxMatchingReplayPreview | null,
  assetId: string,
  replacementWorkpaperChangeId: string,
  reason: string,
  idempotencyKey: string,
): TaxMatchingReplayInput {
  if (!preview || preview.assetId !== assetId ||
      preview.replacementWorkpaperChangeId !== replacementWorkpaperChangeId)
    throw new Error("Reload matching history for this replacement workpaper before proposing replay");
  if (!preview.citedHistoricalPeriodIds.length)
    throw new Error("No earlier matching year requires replay; re-run the latest computed year from Fixed Assets tax pools");
  const trimmed = reason.trim();
  if (trimmed.length < 8 || trimmed.length > 1000)
    throw new Error("Record a replay reason between 8 and 1,000 characters");
  return {
    replacementWorkpaperChangeId: preview.replacementWorkpaperChangeId,
    citedHistoricalPeriodIds: [...preview.citedHistoricalPeriodIds],
    reason: trimmed,
    idempotencyKey,
  };
}
