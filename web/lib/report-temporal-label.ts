import type { ReportTemporalBucket } from "@openbooks/reports";
import { civilDateLabel } from "@openbooks/engine/platform/civil-date-labels";
import { canonicalPeriodLabel } from "@openbooks/engine/periods/period-policy";

/** Display labels use civil bounds; report drill targets retain their ISO bounds. */
export function reportTemporalBucketLabel(
  bucket: ReportTemporalBucket,
  locale: string,
): string | null {
  const month = (date: string) => civilDateLabel(date, locale, "monthYear");
  const span = () => {
    const first = month(bucket.from);
    const last = month(bucket.to);
    return first === last ? first : `${first} – ${last}`;
  };
  switch (bucket.bin) {
    case "day":
      return civilDateLabel(bucket.from, locale);
    case "week":
      return `${civilDateLabel(bucket.from, locale)} – ${civilDateLabel(bucket.to, locale)}`;
    case "month":
      return month(bucket.from);
    case "quarter":
      return span();
    case "year":
      return bucket.from.slice(0, 4);
    case "fiscal_period":
      return bucket.fiscalYear !== undefined && bucket.number !== undefined
        ? `${canonicalPeriodLabel({ fiscalYear: bucket.fiscalYear, periodNumber: bucket.number, adjustment: false })} · ${span()}`
        : null;
    case "fiscal_quarter":
      return bucket.fiscalYear !== undefined && bucket.number !== undefined
        ? `Q${bucket.number} FY${bucket.fiscalYear} · ${span()}`
        : null;
    case "fiscal_year":
      return bucket.fiscalYear !== undefined ? `FY${bucket.fiscalYear} · ${span()}` : null;
  }
}
