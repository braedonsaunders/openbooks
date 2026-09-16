import { canonicalDecimal } from "./exact-decimal.ts";
import { add, neg, normalizeDecimal, fromUnits, roundDiv, toUnits } from "./money.ts";

/**
 * Supported ISO 4217 currencies for a self-hosted OpenBooks installation.
 *
 * This registry is deliberately code-owned and tenant-neutral: deployment
 * bootstrap seeds it into `currencies`, while client pickers consume the same
 * list. `minorUnits` is the ISO accounting exponent, not a cash-rounding rule.
 *
 * Coverage is the full active ISO 4217 list: every entry of the vendored
 * `iso-4217.json` table that carries a numeric minor unit, pinned by
 * `currencies-iso-registry.test.ts`, which refuses drift in either direction.
 * Display names follow ISO except fourteen grandfathered demonym-prefixed
 * names already seeded into tenant databases (see the test's legacy map).
 */

export class CurrencyError extends Error {
  readonly name = "CurrencyError";
}

/**
 * Settle a sequence of exact (ledger-precision) amounts into whole minor units
 * of a currency, carrying the rounding residual forward so the settled total
 * is the rounded cumulative amount exactly. Each returned amount is the
 * rounded running total minus what prior entries already settled; the last
 * entry of a batch absorbs the batch's residual, so the batch sums exactly.
 * `priorExact` replays already-settled history (same policy, oldest first)
 * and only seeds the running totals — nothing is returned for it. With 4
 * minor units the settler is the identity. Retainage uses this per draw (and
 * across draws via replay) so the sum of releases equals total retained
 * exactly in zero-, two- and three-decimal currencies.
 *
 * Precondition: inputs are non-negative exact amounts. Rounding is half away
 * from zero on the running total; gross inputs already in whole minor units
 * keep every settled amount non-negative.
 */
export function settleCumulativeRetainage(
  priorExact: readonly string[],
  currentExact: readonly string[],
  minorUnits: number,
): string[] {
  if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) {
    throw new CurrencyError("Currency minor units must be an integer between zero and four");
  }
  let exactRunning = "0.0000";
  let roundedRunning = "0.0000";
  const settleOne = (exact: string): string => {
    exactRunning = add(exactRunning, exact);
    const target = roundCurrencyMoney(exactRunning, minorUnits);
    const settled = add(target, neg(roundedRunning));
    roundedRunning = target;
    return settled;
  };
  for (const exact of priorExact) settleOne(exact);
  return currentExact.map(settleOne);
}

/** Round a payable amount to its registered currency exponent, half away from zero. */
export function roundCurrencyMoney(amount: string, minorUnits: number): string {
  if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) {
    throw new CurrencyError("Currency minor units must be an integer between zero and four");
  }
  const quantum = 10n ** BigInt(4 - minorUnits);
  const units = toUnits(amount);
  const rounded = roundDiv(units < 0n ? -units : units, quantum) * quantum;
  return fromUnits(units < 0n ? -rounded : rounded);
}

/**
 * Persist-time FX rate: exact decimal at numeric(19,10). Fail closed — a
 * non-canonical or non-positive rate must not be written.
 */
export function updateFxRate(input: { rate: unknown }): string {
  const exact = canonicalDecimal(input.rate, 10);
  if (exact === null) throw new CurrencyError("FX rate must be an exact decimal");
  try {
    const rate = normalizeDecimal(exact, 10);
    if (rate.startsWith("-") || /^0(?:\.0+)?$/.test(rate)) {
      throw new CurrencyError("FX rate must be greater than zero");
    }
    return rate;
  } catch (error) {
    if (error instanceof CurrencyError) throw error;
    throw new CurrencyError("FX rate must be an exact decimal");
  }
}

export interface SupportedCurrency {
  code: string;
  name: string;
  minorUnits: number;
}

export const SUPPORTED_CURRENCIES: SupportedCurrency[] = [
  { code: "AED", name: "UAE Dirham", minorUnits: 2 },
  { code: "AFN", name: "Afghani", minorUnits: 2 },
  { code: "ALL", name: "Lek", minorUnits: 2 },
  { code: "AMD", name: "Armenian Dram", minorUnits: 2 },
  { code: "AOA", name: "Kwanza", minorUnits: 2 },
  { code: "ARS", name: "Argentine Peso", minorUnits: 2 },
  { code: "AUD", name: "Australian Dollar", minorUnits: 2 },
  { code: "AWG", name: "Aruban Florin", minorUnits: 2 },
  { code: "AZN", name: "Azerbaijan Manat", minorUnits: 2 },
  { code: "BAM", name: "Convertible Mark", minorUnits: 2 },
  { code: "BBD", name: "Barbados Dollar", minorUnits: 2 },
  { code: "BDT", name: "Taka", minorUnits: 2 },
  { code: "BHD", name: "Bahraini Dinar", minorUnits: 3 },
  { code: "BIF", name: "Burundi Franc", minorUnits: 0 },
  { code: "BMD", name: "Bermudian Dollar", minorUnits: 2 },
  { code: "BND", name: "Brunei Dollar", minorUnits: 2 },
  { code: "BOB", name: "Boliviano", minorUnits: 2 },
  { code: "BOV", name: "Mvdol", minorUnits: 2 },
  { code: "BRL", name: "Brazilian Real", minorUnits: 2 },
  { code: "BSD", name: "Bahamian Dollar", minorUnits: 2 },
  { code: "BTN", name: "Ngultrum", minorUnits: 2 },
  { code: "BWP", name: "Pula", minorUnits: 2 },
  { code: "BYN", name: "Belarusian Ruble", minorUnits: 2 },
  { code: "BZD", name: "Belize Dollar", minorUnits: 2 },
  { code: "CAD", name: "Canadian Dollar", minorUnits: 2 },
  { code: "CDF", name: "Congolese Franc", minorUnits: 2 },
  { code: "CHE", name: "WIR Euro", minorUnits: 2 },
  { code: "CHF", name: "Swiss Franc", minorUnits: 2 },
  { code: "CHW", name: "WIR Franc", minorUnits: 2 },
  { code: "CLF", name: "Unidad de Fomento", minorUnits: 4 },
  { code: "CLP", name: "Chilean Peso", minorUnits: 0 },
  { code: "CNY", name: "Chinese Yuan", minorUnits: 2 },
  { code: "COP", name: "Colombian Peso", minorUnits: 2 },
  { code: "COU", name: "Unidad de Valor Real", minorUnits: 2 },
  { code: "CRC", name: "Costa Rican Colon", minorUnits: 2 },
  { code: "CUP", name: "Cuban Peso", minorUnits: 2 },
  { code: "CVE", name: "Cabo Verde Escudo", minorUnits: 2 },
  { code: "CZK", name: "Czech Koruna", minorUnits: 2 },
  { code: "DJF", name: "Djibouti Franc", minorUnits: 0 },
  { code: "DKK", name: "Danish Krone", minorUnits: 2 },
  { code: "DOP", name: "Dominican Peso", minorUnits: 2 },
  { code: "DZD", name: "Algerian Dinar", minorUnits: 2 },
  { code: "EGP", name: "Egyptian Pound", minorUnits: 2 },
  { code: "ERN", name: "Nakfa", minorUnits: 2 },
  { code: "ETB", name: "Ethiopian Birr", minorUnits: 2 },
  { code: "EUR", name: "Euro", minorUnits: 2 },
  { code: "FJD", name: "Fiji Dollar", minorUnits: 2 },
  { code: "FKP", name: "Falkland Islands Pound", minorUnits: 2 },
  { code: "GBP", name: "British Pound", minorUnits: 2 },
  { code: "GEL", name: "Lari", minorUnits: 2 },
  { code: "GHS", name: "Ghana Cedi", minorUnits: 2 },
  { code: "GIP", name: "Gibraltar Pound", minorUnits: 2 },
  { code: "GMD", name: "Dalasi", minorUnits: 2 },
  { code: "GNF", name: "Guinean Franc", minorUnits: 0 },
  { code: "GTQ", name: "Quetzal", minorUnits: 2 },
  { code: "GYD", name: "Guyana Dollar", minorUnits: 2 },
  { code: "HKD", name: "Hong Kong Dollar", minorUnits: 2 },
  { code: "HNL", name: "Lempira", minorUnits: 2 },
  { code: "HTG", name: "Gourde", minorUnits: 2 },
  { code: "HUF", name: "Hungarian Forint", minorUnits: 2 },
  { code: "IDR", name: "Indonesian Rupiah", minorUnits: 2 },
  { code: "ILS", name: "Israeli Shekel", minorUnits: 2 },
  { code: "INR", name: "Indian Rupee", minorUnits: 2 },
  { code: "IQD", name: "Iraqi Dinar", minorUnits: 3 },
  { code: "IRR", name: "Iranian Rial", minorUnits: 2 },
  { code: "ISK", name: "Icelandic Krona", minorUnits: 0 },
  { code: "JMD", name: "Jamaican Dollar", minorUnits: 2 },
  { code: "JOD", name: "Jordanian Dinar", minorUnits: 3 },
  { code: "JPY", name: "Japanese Yen", minorUnits: 0 },
  { code: "KES", name: "Kenyan Shilling", minorUnits: 2 },
  { code: "KGS", name: "Som", minorUnits: 2 },
  { code: "KHR", name: "Riel", minorUnits: 2 },
  { code: "KMF", name: "Comorian Franc", minorUnits: 0 },
  { code: "KPW", name: "North Korean Won", minorUnits: 2 },
  { code: "KRW", name: "South Korean Won", minorUnits: 0 },
  { code: "KWD", name: "Kuwaiti Dinar", minorUnits: 3 },
  { code: "KYD", name: "Cayman Islands Dollar", minorUnits: 2 },
  { code: "KZT", name: "Tenge", minorUnits: 2 },
  { code: "LAK", name: "Lao Kip", minorUnits: 2 },
  { code: "LBP", name: "Lebanese Pound", minorUnits: 2 },
  { code: "LKR", name: "Sri Lanka Rupee", minorUnits: 2 },
  { code: "LRD", name: "Liberian Dollar", minorUnits: 2 },
  { code: "LSL", name: "Loti", minorUnits: 2 },
  { code: "LYD", name: "Libyan Dinar", minorUnits: 3 },
  { code: "MAD", name: "Moroccan Dirham", minorUnits: 2 },
  { code: "MDL", name: "Moldovan Leu", minorUnits: 2 },
  { code: "MGA", name: "Malagasy Ariary", minorUnits: 2 },
  { code: "MKD", name: "Denar", minorUnits: 2 },
  { code: "MMK", name: "Kyat", minorUnits: 2 },
  { code: "MNT", name: "Tugrik", minorUnits: 2 },
  { code: "MOP", name: "Pataca", minorUnits: 2 },
  { code: "MRU", name: "Ouguiya", minorUnits: 2 },
  { code: "MUR", name: "Mauritius Rupee", minorUnits: 2 },
  { code: "MVR", name: "Rufiyaa", minorUnits: 2 },
  { code: "MWK", name: "Malawi Kwacha", minorUnits: 2 },
  { code: "MXN", name: "Mexican Peso", minorUnits: 2 },
  { code: "MXV", name: "Mexican Unidad de Inversion (UDI)", minorUnits: 2 },
  { code: "MYR", name: "Malaysian Ringgit", minorUnits: 2 },
  { code: "MZN", name: "Mozambique Metical", minorUnits: 2 },
  { code: "NAD", name: "Namibia Dollar", minorUnits: 2 },
  { code: "NGN", name: "Nigerian Naira", minorUnits: 2 },
  { code: "NIO", name: "Cordoba Oro", minorUnits: 2 },
  { code: "NOK", name: "Norwegian Krone", minorUnits: 2 },
  { code: "NPR", name: "Nepalese Rupee", minorUnits: 2 },
  { code: "NZD", name: "New Zealand Dollar", minorUnits: 2 },
  { code: "OMR", name: "Rial Omani", minorUnits: 3 },
  { code: "PAB", name: "Balboa", minorUnits: 2 },
  { code: "PEN", name: "Sol", minorUnits: 2 },
  { code: "PGK", name: "Kina", minorUnits: 2 },
  { code: "PHP", name: "Philippine Peso", minorUnits: 2 },
  { code: "PKR", name: "Pakistani Rupee", minorUnits: 2 },
  { code: "PLN", name: "Polish Zloty", minorUnits: 2 },
  { code: "PYG", name: "Guarani", minorUnits: 0 },
  { code: "QAR", name: "Qatari Rial", minorUnits: 2 },
  { code: "RON", name: "Romanian Leu", minorUnits: 2 },
  { code: "RSD", name: "Serbian Dinar", minorUnits: 2 },
  { code: "RUB", name: "Russian Ruble", minorUnits: 2 },
  { code: "RWF", name: "Rwanda Franc", minorUnits: 0 },
  { code: "SAR", name: "Saudi Riyal", minorUnits: 2 },
  { code: "SBD", name: "Solomon Islands Dollar", minorUnits: 2 },
  { code: "SCR", name: "Seychelles Rupee", minorUnits: 2 },
  { code: "SDG", name: "Sudanese Pound", minorUnits: 2 },
  { code: "SEK", name: "Swedish Krona", minorUnits: 2 },
  { code: "SGD", name: "Singapore Dollar", minorUnits: 2 },
  { code: "SHP", name: "Saint Helena Pound", minorUnits: 2 },
  { code: "SLE", name: "Leone", minorUnits: 2 },
  { code: "SOS", name: "Somali Shilling", minorUnits: 2 },
  { code: "SRD", name: "Surinam Dollar", minorUnits: 2 },
  { code: "SSP", name: "South Sudanese Pound", minorUnits: 2 },
  { code: "STN", name: "Dobra", minorUnits: 2 },
  { code: "SVC", name: "El Salvador Colon", minorUnits: 2 },
  { code: "SYP", name: "Syrian Pound", minorUnits: 2 },
  { code: "SZL", name: "Lilangeni", minorUnits: 2 },
  { code: "THB", name: "Thai Baht", minorUnits: 2 },
  { code: "TJS", name: "Somoni", minorUnits: 2 },
  { code: "TMT", name: "Turkmenistan New Manat", minorUnits: 2 },
  { code: "TND", name: "Tunisian Dinar", minorUnits: 3 },
  { code: "TOP", name: "Pa’anga", minorUnits: 2 },
  { code: "TRY", name: "Turkish Lira", minorUnits: 2 },
  { code: "TTD", name: "Trinidad and Tobago Dollar", minorUnits: 2 },
  { code: "TWD", name: "New Taiwan Dollar", minorUnits: 2 },
  { code: "TZS", name: "Tanzanian Shilling", minorUnits: 2 },
  { code: "UAH", name: "Hryvnia", minorUnits: 2 },
  { code: "UGX", name: "Uganda Shilling", minorUnits: 0 },
  { code: "USD", name: "US Dollar", minorUnits: 2 },
  { code: "USN", name: "US Dollar (Next day)", minorUnits: 2 },
  { code: "UYI", name: "Uruguay Peso en Unidades Indexadas (UI)", minorUnits: 0 },
  { code: "UYU", name: "Peso Uruguayo", minorUnits: 2 },
  { code: "UYW", name: "Unidad Previsional", minorUnits: 4 },
  { code: "UZS", name: "Uzbekistan Sum", minorUnits: 2 },
  { code: "VED", name: "Bolívar Soberano", minorUnits: 2 },
  { code: "VES", name: "Bolívar Soberano", minorUnits: 2 },
  { code: "VND", name: "Vietnamese Dong", minorUnits: 0 },
  { code: "VUV", name: "Vatu", minorUnits: 0 },
  { code: "WST", name: "Tala", minorUnits: 2 },
  { code: "XAD", name: "Arab Accounting Dinar", minorUnits: 2 },
  { code: "XAF", name: "CFA Franc BEAC", minorUnits: 0 },
  { code: "XCD", name: "East Caribbean Dollar", minorUnits: 2 },
  { code: "XCG", name: "Caribbean Guilder", minorUnits: 2 },
  { code: "XOF", name: "CFA Franc BCEAO", minorUnits: 0 },
  { code: "XPF", name: "CFP Franc", minorUnits: 0 },
  { code: "YER", name: "Yemeni Rial", minorUnits: 2 },
  { code: "ZAR", name: "South African Rand", minorUnits: 2 },
  { code: "ZMW", name: "Zambian Kwacha", minorUnits: 2 },
  { code: "ZWG", name: "Zimbabwe Gold", minorUnits: 2 },
];

export const SUPPORTED_CURRENCY_CODES = new Set(
  SUPPORTED_CURRENCIES.map((currency) => currency.code),
);

/**
 * Active ISO 4217 entries with NO defined minor unit (supranational units,
 * bond-market units, test codes, XXX). No quantum exists to round them with,
 * so they stay out of the registry and fail closed wherever a currency row is
 * required. Pinned by `currencies-iso-registry.test.ts` against the vendored
 * table — admitting one of these is a product decision, not drift.
 */
export const NON_TRANSACTABLE_ISO_CODES: ReadonlySet<string> = new Set([
  "XAG",
  "XAU",
  "XBA",
  "XBB",
  "XBC",
  "XBD",
  "XDR",
  "XPD",
  "XPT",
  "XSU",
  "XTS",
  "XUA",
  "XXX",
]);
