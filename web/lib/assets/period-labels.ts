import {
  periodDisplayLabel,
  type PeriodDisplayInput,
} from "@openbooks/engine/periods/period-policy";
import type {
  DepreciationPreview,
  RunDepreciationResult,
} from "@openbooks/engine/assets/depreciation";

/**
 * Depreciation payloads with their periods labelled in the viewer's locale
 * (`P05 FY2026 · May 2026`), the way every period list labels them. The
 * engine names periods with locale-free labels for refusal, warning and
 * problem text and carries each period's fiscal position and dates beside
 * it; ids, amounts, fingerprints and refusal text are unchanged here.
 */

/** A depreciation preview with its line and manual-entry periods labelled. */
export function labelDepreciationPreview(
  preview: DepreciationPreview,
  locale: string,
): DepreciationPreview {
  return {
    ...preview,
    rows: preview.rows.map((row) => ({
      ...row,
      periodName: periodDisplayLabel(row.periodRef, locale),
    })),
    manualEntryCandidates: preview.manualEntryCandidates.map((candidate) => ({
      ...candidate,
      periodName: periodDisplayLabel(candidate.periodRef, locale),
    })),
  };
}

/** A depreciation run result with every per-line period labelled. */
export function labelDepreciationRun(
  result: RunDepreciationResult,
  locale: string,
): RunDepreciationResult {
  const label = <T extends { periodRef: PeriodDisplayInput }>(item: T): T & { period: string } => ({
    ...item,
    period: periodDisplayLabel(item.periodRef, locale),
  });
  return {
    ...result,
    entries: result.entries.map(label),
    recordedEntries: result.recordedEntries.map(label),
    skippedAssets: result.skippedAssets.map(label),
    problemItems: result.problemItems.map(label),
    nextDue: result.nextDue ? label(result.nextDue) : null,
  };
}
