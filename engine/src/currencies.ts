import { canonicalDecimal } from "./exact-decimal.ts";
import { normalizeDecimal } from "./money.ts";

/**
 * Supported ISO 4217 currencies for a self-hosted OpenBooks installation.
 *
 * This registry is deliberately code-owned and tenant-neutral: deployment
 * bootstrap seeds it into `currencies`, while client pickers consume the same
 * list. `minorUnits` is the ISO accounting exponent, not a cash-rounding rule.
 */

export class CurrencyError extends Error {
  readonly name = "CurrencyError";
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
  { code: "USD", name: "US Dollar", minorUnits: 2 },
  { code: "CAD", name: "Canadian Dollar", minorUnits: 2 },
  { code: "EUR", name: "Euro", minorUnits: 2 },
  { code: "GBP", name: "British Pound", minorUnits: 2 },
  { code: "AUD", name: "Australian Dollar", minorUnits: 2 },
  { code: "NZD", name: "New Zealand Dollar", minorUnits: 2 },
  { code: "JPY", name: "Japanese Yen", minorUnits: 0 },
  { code: "CHF", name: "Swiss Franc", minorUnits: 2 },
  { code: "CNY", name: "Chinese Yuan", minorUnits: 2 },
  { code: "HKD", name: "Hong Kong Dollar", minorUnits: 2 },
  { code: "SGD", name: "Singapore Dollar", minorUnits: 2 },
  { code: "INR", name: "Indian Rupee", minorUnits: 2 },
  { code: "MXN", name: "Mexican Peso", minorUnits: 2 },
  { code: "BRL", name: "Brazilian Real", minorUnits: 2 },
  { code: "ZAR", name: "South African Rand", minorUnits: 2 },
  { code: "SEK", name: "Swedish Krona", minorUnits: 2 },
  { code: "NOK", name: "Norwegian Krone", minorUnits: 2 },
  { code: "DKK", name: "Danish Krone", minorUnits: 2 },
  { code: "PLN", name: "Polish Zloty", minorUnits: 2 },
  { code: "CZK", name: "Czech Koruna", minorUnits: 2 },
  { code: "HUF", name: "Hungarian Forint", minorUnits: 2 },
  { code: "RON", name: "Romanian Leu", minorUnits: 2 },
  { code: "TRY", name: "Turkish Lira", minorUnits: 2 },
  { code: "AED", name: "UAE Dirham", minorUnits: 2 },
  { code: "SAR", name: "Saudi Riyal", minorUnits: 2 },
  { code: "ILS", name: "Israeli Shekel", minorUnits: 2 },
  { code: "KRW", name: "South Korean Won", minorUnits: 0 },
  { code: "THB", name: "Thai Baht", minorUnits: 2 },
  { code: "MYR", name: "Malaysian Ringgit", minorUnits: 2 },
  { code: "IDR", name: "Indonesian Rupiah", minorUnits: 2 },
  { code: "PHP", name: "Philippine Peso", minorUnits: 2 },
  { code: "VND", name: "Vietnamese Dong", minorUnits: 0 },
  { code: "CLP", name: "Chilean Peso", minorUnits: 0 },
  { code: "COP", name: "Colombian Peso", minorUnits: 2 },
  { code: "ARS", name: "Argentine Peso", minorUnits: 2 },
  { code: "EGP", name: "Egyptian Pound", minorUnits: 2 },
  { code: "NGN", name: "Nigerian Naira", minorUnits: 2 },
  { code: "KES", name: "Kenyan Shilling", minorUnits: 2 },
  { code: "PKR", name: "Pakistani Rupee", minorUnits: 2 },
  { code: "ISK", name: "Icelandic Krona", minorUnits: 0 },
];

export const SUPPORTED_CURRENCY_CODES = new Set(
  SUPPORTED_CURRENCIES.map((currency) => currency.code),
);
