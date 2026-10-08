import { fromUnits } from "../money/money.ts";

/**
 * Authoritative Stripe-scale minor-unit table for every Stripe-money boundary
 * (checkout, webhooks, payout import). This is Stripe's contract only:
 * Chargebee names its own smaller zero-decimal set (JPY, KRW, XAF, XOF —
 * see CHARGEBEE_ZERO_DECIMAL in psp-settlement.ts) and Adyen yet another
 * (ADYEN_ZERO_DECIMAL in acceptance.ts, plus ADYEN_THREE_DECIMAL: Adyen explicitly
 * supports three-decimal minor units through its own table), so neither may
 * reuse this list.
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
/** ISO 4217 three-decimal set: millis scale on Stripe boundaries (Stripe
 * supports them), fail-closed rejection on Chargebee (contract unverified). */
export const THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
]);

/**
 * Provider minor units → major-unit money string (exact). Single authoritative
 * Stripe-scale conversion: zero-decimal currencies arrive as whole major
 * units, three-decimal currencies (e.g. BHD fils) as millis, two-decimal
 * currencies as cents; money uses 4dp of the major unit (123 cents = 1.2300
 * → 12300 units; 1000 fils = 1.0000 → 10000 units). Shared with
 * psp-settlement.ts so the checkout webhook and the payout importer cannot
 * drift apart.
 */
export function fromMinorUnits(amount: bigint, currency: string): string {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return fromUnits(amount * 10_000n);
  if (THREE_DECIMAL_CURRENCIES.has(code)) return fromUnits(amount * 10n);
  return fromUnits(amount * 100n);
}
