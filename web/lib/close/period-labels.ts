import { periodDisplayLabel } from "@openbooks/engine/periods/period-policy";
import type { PostingPeriodCandidate } from "@openbooks/engine/close/posting-periods";
import type {
  PeriodEndPeriodLabel,
  PeriodEndPreview,
} from "@openbooks/engine/close/period-end-journals";

/**
 * Close payloads with their periods labelled in the viewer's locale
 * (`P05 FY2026 · May 2026`), the way every period list labels them. The
 * engine names periods with locale-free labels for refusal text and carries
 * each period's fiscal position and dates beside it; ids and refusal text
 * are unchanged here.
 */

/** Posting-period candidates with their derived period and adjustment alternative labelled. */
export function labelPostingPeriodCandidates(
  rows: PostingPeriodCandidate[],
  locale: string,
): PostingPeriodCandidate[] {
  return rows.map((row) => ({
    ...row,
    periodName: row.periodRef ? periodDisplayLabel(row.periodRef, locale) : row.periodName,
    adjustmentPeriod: row.adjustmentPeriod
      ? {
          ...row.adjustmentPeriod,
          name: periodDisplayLabel(row.adjustmentPeriod.periodRef, locale),
        }
      : null,
  }));
}

/** A period-end journals preview with its closing, opening and journal periods labelled. */
export function labelPeriodEndPreview(preview: PeriodEndPreview, locale: string): PeriodEndPreview {
  const label = (period: PeriodEndPeriodLabel | null): PeriodEndPeriodLabel | null =>
    period ? { ...period, name: periodDisplayLabel(period.periodRef, locale) } : null;
  return {
    ...preview,
    fiscalYear: {
      ...preview.fiscalYear,
      closingPeriod: label(preview.fiscalYear.closingPeriod),
      openingPeriod: label(preview.fiscalYear.openingPeriod),
    },
    entities: preview.entities.map((entity) => ({
      ...entity,
      journals: entity.journals.map((journal) => ({
        ...journal,
        periodName: periodDisplayLabel(journal.periodRef, locale),
      })),
    })),
  };
}
