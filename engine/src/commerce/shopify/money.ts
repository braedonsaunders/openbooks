import { SUPPORTED_CURRENCIES } from "../../fx/currencies.ts";
import { CommerceError } from "../errors.ts";

/**
 * Shopify money arrives as decimal strings beside an ISO currency code
 * (`{ amount: "19.99", currencyCode: "USD" }`). Minor-unit conversion needs
 * the currency's ISO exponent, which lives in the fx currency list — so
 * this conversion sits in the commerce pack, never in the HTTP client.
 * Anything that is not an exact decimal, or carries more fraction digits
 * than the currency allows, is refused by name: rounding a storefront
 * price silently would post a number nobody typed.
 */
export function shopifyDecimalToMinor(amount: unknown, currencyCode: unknown): bigint {
  const code = typeof currencyCode === "string" ? currencyCode.trim().toUpperCase() : "";
  const currency = SUPPORTED_CURRENCIES.find((entry) => entry.code === code);
  if (!currency) {
    throw new CommerceError(
      "shopify_currency_unknown",
      `Shopify priced an amount in "${typeof currencyCode === "string" ? currencyCode : "unknown"}", which is not a supported currency.`,
      "Connect a shop whose currency OpenBooks supports, or ask your administrator to add the currency first.",
      { field: "currency" },
    );
  }
  const text = typeof amount === "string" ? amount.trim() : "";
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new CommerceError(
      "shopify_price_unreadable",
      `Shopify sent a price of "${text === "" ? "nothing" : text}" that is not an exact decimal amount.`,
      "Correct the price in Shopify admin so it reads as digits with an optional decimal point, then re-import.",
      { field: "price" },
    );
  }
  const fraction = match[3] ?? "";
  if (fraction.length > currency.minorUnits) {
    throw new CommerceError(
      "shopify_price_too_precise",
      `Shopify price ${text} ${code} carries ${fraction.length} decimals, more than the currency allows (${currency.minorUnits}).`,
      "Round the price in Shopify admin to the currency's decimals, then re-import.",
      { field: "price" },
    );
  }
  const scaled = `${match[1] === "-" ? "-" : ""}${match[2]}${fraction.padEnd(currency.minorUnits, "0")}`;
  const normalized = scaled.replace(/^(-?)0+(?=\d)/, "$1");
  return BigInt(normalized === "" || normalized === "-" ? "0" : normalized);
}

/** Canonical decimal string (scale 4) for storage in rate columns. */
export function shopifyDecimalToRate(amount: unknown): string {
  const text = typeof amount === "string" ? amount.trim() : "";
  if (!/^\d+(?:\.\d{1,4})?$/.test(text)) {
    throw new CommerceError(
      "shopify_price_unreadable",
      `Shopify sent a price of "${text === "" ? "nothing" : text}" that is not a storable rate.`,
      "Correct the price in Shopify admin so it reads as a non-negative amount with at most four decimals, then re-import.",
      { field: "price" },
    );
  }
  const [whole, fraction = ""] = text.split(".");
  return `${whole}.${fraction.padEnd(4, "0")}`;
}
