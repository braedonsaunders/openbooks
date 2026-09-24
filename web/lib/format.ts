export function dateTime(v: string | Date | null | undefined, locale = "en-CA"): string {
  if (!v) return "";
  return new Date(v).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Short week-start label for trend charts ("Jan 5"), rendered in the
 * viewer's locale (F2-14). The locale is required: a default here would let
 * a loader silently pin every viewer to one language, which is the defect
 * this exists to fix. Midnight UTC keeps the label on the week's first day
 * regardless of the viewer's time zone.
 */
export function trendWeekLabel(weekStart: string, locale: string): string {
  return new Date(weekStart + "T00:00:00Z").toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Full viewer-facing calendar date ("Sep 7, 2026") for drawers and tables
 * (F2-14b). The instant stays with the caller — pass the Date the call site
 * already builds — so only the language changes, never the day. Midnight
 * and noon UTC constructions both land on the intended date because the
 * format pins timeZone: "UTC".
 */
export function dateLabel(day: Date, locale: string): string {
  return day.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Short viewer-facing date ("Sep 7") for compact labels (F2-14b). */
export function shortDateLabel(day: Date, locale: string): string {
  return day.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Month-and-year viewer label for drill groupings (F2-14b): "Sep ’26" with
 * the default 2-digit year, "Sep 2026" with "numeric". The width travels
 * with the caller so adopting the helper never restyles an existing label.
 */
export function monthYearLabel(
  firstOfMonth: Date,
  locale: string,
  year: "2-digit" | "numeric" = "2-digit",
): string {
  return firstOfMonth.toLocaleDateString(locale, {
    month: "short",
    year,
    timeZone: "UTC",
  });
}

/** Bare short-month viewer label ("Sep" per locale) for axis ticks (F2-14b). */
export function monthLabel(day: Date, locale: string): string {
  return day.toLocaleString(locale, { month: "short", timeZone: "UTC" });
}

/**
 * Viewer-facing integer grouping ("50,000" vs "50 000") for counts (F2-14b).
 * Display only: anything round-tripped against exports or the ledger must
 * keep its pinned machine format, never this helper.
 */
export function countLabel(value: number, locale: string): string {
  return value.toLocaleString(locale);
}

/**
 * Viewer-facing decimal with trimmed trailing zeros (1.7500 → 1.75)
 * for setup and preview tables (F2-14b). Display only, like countLabel.
 */
export function decimalLabel(value: number, locale: string, minimumFractionDigits: number, maximumFractionDigits: number): string {
  return value.toLocaleString(locale, { minimumFractionDigits, maximumFractionDigits });
}

/** Viewer-facing whole-unit currency for kanban cards (F2-14b). */
export function currencyLabel(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}
