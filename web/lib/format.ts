export function dateTime(v: string | Date | null | undefined, locale = "en-CA"): string {
  if (!v) return "";
  return new Date(v).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Locale-aware country name for a two-letter region code ("JP" → "Japan" in
 * en, "Japon" in fr), via Intl.DisplayNames — never a hardcoded map, so a
 * newly installed pack needs no edit here.
 *
 * `locale` is required (no default): dateTime's "en-CA" default is harmless
 * for a date and wrong for a name, where a forgotten locale would silently
 * render English. Fail visible, not fail fatal: Intl throws RangeError on a
 * structurally invalid code ("" or "1A") and returns the input for a valid
 * but unassigned one ("XX"), so an unrenderable code comes back as itself
 * rather than taking the page down or inventing a name.
 */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region", fallback: "code" }).of(code) ?? code;
  } catch {
    return code;
  }
}
