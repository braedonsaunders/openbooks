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

/**
 * Whole-unit counts (rows, lines, documents) in the operator locale — never
 * a hardcoded 'en-CA'/'en-US' literal at the call site.
 */
export function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

/**
 * A 0–1 fraction as a localized percent string. String-concatenating '%'
 * hardcodes the English placement (`13%` vs the French `13 %` vs the Turkish
 * `%13`), so every bare `${rate}%` goes through here instead.
 */
export function formatPercent01(fraction: number, locale: string, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits }).format(fraction);
}

/**
 * Shared viewer-facing formatting primitives. Locale and time zone are
 * required so UI call sites cannot inherit the host machine's settings.
 */
export function viewerDate(
  value: Date | string,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: options.timeZone ?? timeZone }).format(
    typeof value === "string" ? new Date(value) : value,
  );
}

export function viewerDateTime(
  value: Date | string,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: options.timeZone ?? timeZone }).format(
    typeof value === "string" ? new Date(value) : value,
  );
}

export function viewerNumber(value: number, locale: string, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

/** Localize an already rounded exact decimal as a percentage without
 * converting its digits through IEEE-754. */
export function formatExactPercent(value: string, locale: string, fractionDigits = 1): string {
  const fixed = fixedDecimal(value, fractionDigits)
  const negative = fixed.startsWith('-')
  const [whole = '0', fraction = ''] = fixed.replace(/^-/, '').split('.')
  const templateFormatter = new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
  const template = templateFormatter.formatToParts(negative ? -1 : 1)
  const isNumberPart = (part: Intl.NumberFormatPart) =>
    part.type === 'integer' || part.type === 'group' || part.type === 'decimal' || part.type === 'fraction'
  const first = template.findIndex(isNumberPart)
  const last = template.findLastIndex(isNumberPart)
  if (first < 0 || last < first) throw new Error('percent formatter did not produce a numeric value')

  const integerParts = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).formatToParts(BigInt(whole))
  const decimal = template.find((part) => part.type === 'decimal')?.value
  const fractionParts = fractionDigits > 0
    ? [
        ...(decimal ? [{ type: 'decimal' as const, value: decimal }] : []),
        ...[...fraction].map((digit) => ({
          type: 'fraction' as const,
          value: new Intl.NumberFormat(locale, { useGrouping: false }).format(Number(digit)),
        })),
      ]
    : []
  return [
    ...template.slice(0, first).map((part) => part.value),
    ...integerParts.map((part) => part.value),
    ...fractionParts.map((part) => part.value),
    ...template.slice(last + 1).map((part) => part.value),
  ].join('')
}

/**
 * A civil YYYY-MM-DD date as a medium date in the operator locale, anchored
 * at UTC noon so the civil day never shifts with the server timezone.
 */
export function formatCivilDate(isoDate: string, locale: string): string {
  return new Date(`${isoDate.slice(0, 10)}T12:00:00Z`).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
import { fixedDecimal } from '@openbooks/engine/src/money/exact-decimal.ts'
