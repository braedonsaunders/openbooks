/**
 * Shared plumbing for catalog-backed analytics strings.
 *
 * `CatalogMessageFn` is the structural shape every bundle builder takes: a
 * `(key, values) => string` lookup. Request-scoped loaders pass
 * `(key, values) => t(key, values)` where `t` comes from
 * `getTranslations('analytics')` (request locale with English fallback — the
 * same locale statements use); unit tests pass `createTranslator` output.
 *
 * Month labels resolve through `analytics.common.monthsShort.*` (named keys —
 * never arrays, which the English-fallback deep merge turns into `{0: …}`
 * objects) composed with the per-locale `analytics.common.monthYear`
 * template, so "Mar '26" becomes "26年3月" where the locale reads that way.
 */

export type CatalogMessageFn = (
  key: string,
  values?: Record<string, string | number>,
) => string;

export const MONTH_KEYS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

/** 12 short month names, Jan→Dec, in the request language. */
export function catalogShortMonths(t: CatalogMessageFn): string[] {
  return MONTH_KEYS.map((k) => t(`common.monthsShort.${k}`));
}

/** "2026-03" → localized "Mar '26" style label. */
export function catalogMonthLabel(t: CatalogMessageFn): (ym: string) => string {
  const shortMonths = catalogShortMonths(t);
  return (ym: string): string => {
    const [y, m] = ym.split("-").map(Number);
    const month = shortMonths[((m ?? 1) - 1 + 12) % 12] ?? ym;
    return t("common.monthYear", { month, yy: String(y ?? "").slice(2) });
  };
}
