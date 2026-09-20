/**
 * ISO 4217 currency codes for currency pickers that can't easily thread the
 * org's `currencies` table (e.g. client-only drawers). Server surfaces that
 * already load `select code, name from currencies` should pass those instead —
 * this is the client-safe fallback so a currency field is NEVER free text.
 */
import { SUPPORTED_CURRENCIES } from "@openbooks/engine/src/fx/currencies.ts";

export interface IsoCurrency {
  code: string;
  name: string;
}

export const ISO_CURRENCIES: IsoCurrency[] = SUPPORTED_CURRENCIES.map(
  ({ code, name }) => ({ code, name }),
);

const REGISTRY_NAME = new Map(SUPPORTED_CURRENCIES.map(({ code, name }) => [code, name]))

/**
 * Localized currency name for a picker label. CLDR (via Intl.DisplayNames)
 * carries every active code in every UI locale, so names localize to the
 * active language automatically — the same convention as countryOptions in
 * lib/countries.ts, and no hand-maintained translations. Falls back to the
 * registry English name (then the code itself) where CLDR has none.
 */
export function currencyDisplayName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'currency' }).of(code) ?? REGISTRY_NAME.get(code) ?? code
  } catch {
    return REGISTRY_NAME.get(code) ?? code
  }
}

/**
 * Currency options for a Select, labelled in the given UI locale and sorted
 * by localized name. The stored value stays the ISO code.
 */
export function currencyOptions(locale: string): { value: string; label: string }[] {
  return SUPPORTED_CURRENCIES.map(({ code }) => ({
    value: code,
    label: `${code} · ${currencyDisplayName(code, locale)}`,
  })).sort((a, b) => a.label.localeCompare(b.label, locale))
}
