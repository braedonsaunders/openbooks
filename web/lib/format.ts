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
