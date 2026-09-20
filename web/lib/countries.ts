// ISO 3166-1 alpha-2 country codes. Display names are derived at render via
// Intl.DisplayNames, so they localize to the active UI language automatically
// (and we don't hand-maintain 249 translated names per locale).

export const COUNTRY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
  'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
] as const

export type CountryCode = (typeof COUNTRY_CODES)[number]

const COUNTRY_CODE_SET: ReadonlySet<string> = new Set(COUNTRY_CODES)

/** True only for a canonical uppercase ISO 3166-1 alpha-2 country code. */
export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === 'string' && COUNTRY_CODE_SET.has(value)
}

/** Normalize user/import input to an ISO code, or reject it. */
export function normalizeCountryCode(value: unknown): CountryCode | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  return isCountryCode(normalized) ? normalized : null
}

/**
 * Locale-aware country name for a two-letter region code ("JP" → "Japan" in
 * en, "Japon" in fr), via Intl.DisplayNames — never a hardcoded map, so a
 * newly installed pack needs no edit here.
 *
 * `locale` is required (no default): a forgotten locale would silently render
 * English names. The parameter stays an arbitrary string rather than
 * CountryCode, because the whole point is that an unrecognised code renders
 * as itself — a type that forbids the bad input would push the failure to
 * the call site, where pack-registry codes arrive as plain strings.
 *
 * Fail visible, not fail fatal: Intl throws RangeError on a structurally
 * invalid code ("" or "1A") and returns the input for a valid but unassigned
 * one ("XX"), so an unrenderable code comes back as itself rather than
 * taking the page down or inventing a name.
 */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region', fallback: 'code' }).of(code) ?? code
  } catch {
    return code
  }
}

/**
 * Country options for a SearchSelect, labelled in the given UI locale and
 * sorted by localized name. The stored value stays the uppercase ISO code.
 * Labels come from countryName, the single place a code becomes a name.
 */
export function countryOptions(locale: string): { value: string; label: string }[] {
  return COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code, locale) })).sort((a, b) =>
    a.label.localeCompare(b.label, locale),
  )
}
