import { fromUnits, mulRate, toUnits } from "../money/money.ts";
import { fromMinorUnits, THREE_DECIMAL_CURRENCIES } from "./minor-units.ts";

/**
 * PSP settlement import — Stripe / Recurly / Chargebee payout batches post
 * through the inventory-style kernel path (balanced journal_entries origin
 * `document` or allocation). Fees, disputes, refunds, adjustments, and FX legs
 * are evidence-backed settlement_lines. Idempotent on (org, provider, externalRef).
 */

export type PspProvider =
  "stripe" | "recurly" | "chargebee" | "shopify_payments" | "paypal" | "square";

/** Every provider the settlement importer accepts. Adding a provider is one entry here, one parser below, and the CHECK widening in the migration. */
export const PSP_PROVIDERS: readonly PspProvider[] = [
  "stripe",
  "recurly",
  "chargebee",
  "shopify_payments",
  "paypal",
  "square",
];

export function isPspProvider(value: string): value is PspProvider {
  return (PSP_PROVIDERS as readonly string[]).includes(value);
}
export type SettlementLineKind =
  | "charge"
  | "refund"
  | "fee"
  | "dispute"
  | "dispute_reversal"
  | "adjustment"
  | "fx_adjustment"
  | "transfer"
  | "other";

/** Realized FX follows the economic direction of each settlement leg. */
export function settlementFxRealizedDelta(
  kind: SettlementLineKind,
  convertedBase: bigint,
  bookedBase: bigint,
): bigint {
  const difference = convertedBase - bookedBase;
  return kind === "refund" || kind === "dispute" || kind === "adjustment"
    ? -difference
    : difference;
}

export class PspSettlementError extends Error {}

export class PspSettlementConflictError extends PspSettlementError {
  constructor(
    message: string,
    readonly persistedBatch: {
      batchId: string;
      status: string;
      provider: string;
      externalRef: string;
      currency: string;
      totals: {
        grossAmount: string;
        feeAmount: string;
        refundAmount: string;
        disputeAmount: string;
        adjustmentAmount: string;
        netAmount: string;
        fxAmount: string;
      };
    },
  ) {
    super(message);
  }
}

export interface ParsedSettlementLine {
  kind: SettlementLineKind;
  amount: string; // signed; fees/refunds usually negative of gross narrative in provider but we store natural sign by kind
  externalRef?: string | null;
  description?: string | null;
  currency?: string | null;
  /** Posted receipt this line settles (charge/refund/dispute legs). The FX
   *  path reads the receipt's booked functional amount to post realized FX. */
  documentId?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Cross-currency evidence for one settlement batch. Rates are exact decimal
 * strings (at most 10 places): `rate` converts one unit of the charges
 * currency into payout currency, `payoutRate` converts one unit of payout
 * currency into the posting entity's base currency (omit when the payout
 * currency already is base). Per-line `exchangeRate` in a line's meta
 * overrides `rate` for that line. A foreign-currency line with neither is
 * refused naming the field to supply — converting at an assumed rate would
 * book money nobody evidenced.
 */
export interface SettlementFxEvidence {
  sourceCurrency: string;
  rate: string;
  rateSource: string;
  payoutRate?: string | null;
  payoutRateSource?: string | null;
}

export interface ParsedSettlement {
  provider: PspProvider;
  externalRef: string;
  settlementDate: string;
  currency: string;
  lines: ParsedSettlementLine[];
  fx?: SettlementFxEvidence | null;
  memo?: string | null;
  raw?: Record<string, unknown>;
}

/**
 * Validate an FX rate shape before it can move money: positive, exact, at
 * most 10 decimal places. The message names the field the operator supplies.
 */
export function requireFxRate(rate: unknown, field: string): string {
  const raw = typeof rate === "number" ? String(rate) : typeof rate === "string" ? rate.trim() : "";
  if (raw === "" || !/^\+?(\d+(\.\d*)?|\.\d+)$/.test(raw)) {
    throw new PspSettlementError(`${field} must be a positive decimal exchange rate`);
  }
  const fraction = raw.replace(/^\+/, "").split(".")[1] ?? "";
  if (fraction.length > 10) {
    throw new PspSettlementError(`${field} must carry at most 10 decimal places`);
  }
  if (toUnits(mulRate("1", raw)) <= 0n) {
    throw new PspSettlementError(`${field} must be greater than zero`);
  }
  return raw.replace(/^\+/, "");
}

/**
 * Chargebee's zero-decimal set is its own contract, NOT the Stripe-scale
 * list: Chargebee "Currency support" (Handling currency units) names exactly
 * KRW, JPY, XAF, XOF as regular-denomination; every other currency —
 * including Stripe zero-decimal ones such as VND or CLP — is smallest-unit.
 */
const CHARGEBEE_ZERO_DECIMAL = new Set(["JPY", "KRW", "XAF", "XOF"]);

/**
 * Shared ISO 4217 shape check behind the provider-named currency refusals.
 * Trim and uppercase before validating, exactly like the Stripe row parser,
 * so a padded " jpy " is accepted as JPY and every caller compares one form.
 */
export function requireSettlementCurrency(
  code: unknown,
  missingMessage: string,
  malformedMessage: string,
): string {
  const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (normalized === "") {
    throw new PspSettlementError(missingMessage);
  }
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new PspSettlementError(malformedMessage);
  }
  return normalized;
}

/**
 * Chargebee invoices always carry currency_code (Chargebee invoice docs:
 * required ISO 4217 string), so a missing code is refused rather than
 * guessed: defaulting a currency-less JPY payload to USD would convert
 * whole-yen amounts as cents and misbook by 100x.
 */
export function requireChargebeeCurrency(code: unknown): string {
  return requireSettlementCurrency(
    code,
    "Chargebee currency_code is required",
    "Chargebee currency_code must be a three-letter currency code",
  );
}

/**
 * Recurly settlements always carry an explicit currency, so a missing code
 * is refused rather than defaulted to USD: a default would silently book a
 * foreign-currency settlement (e.g. whole-yen JPY amounts) as dollars.
 * The remedy names the import action that re-parses the provider payload,
 * so the operator can correct the payload and import again.
 */
export function requireRecurlyCurrency(code: unknown): string {
  return requireSettlementCurrency(
    code,
    "Recurly currency is required; re-import the settlement with an explicit three-letter currency code",
    "Recurly currency must be a three-letter currency code; re-import the settlement with a corrected currency code",
  );
}

function rejectThreeDecimal(field: string, code: string): void {
  if (THREE_DECIMAL_CURRENCIES.has(code)) {
    throw new PspSettlementError(
      `${field} currency ${code} uses three-decimal minor units and requires explicit conversion evidence`,
    );
  }
}

export function fromPspMinorUnits(
  amount: number,
  field: string,
  absolute = false,
  currency = "USD",
): string {
  if (!Number.isSafeInteger(amount)) {
    throw new PspSettlementError(`${field} must be a safe integer in provider minor units`);
  }
  const code = currency.toUpperCase();
  const units = BigInt(amount);
  const magnitude = absolute && units < 0n ? -units : units;
  // Stripe-scale conversion is authoritative in payment-acceptance.ts: shared
  // with the checkout webhook so payout import cannot drift from acceptance.
  // Three-decimal currencies convert there too (Stripe supports them);
  // Chargebee keeps its own fail-closed rejection below.
  return fromMinorUnits(magnitude, code);
}

export function fromChargebeeMinorUnits(
  amount: number,
  field: string,
  absolute = false,
  currency = "USD",
): string {
  if (!Number.isSafeInteger(amount)) {
    throw new PspSettlementError(`${field} must be a safe integer in provider minor units`);
  }
  const code = currency.toUpperCase();
  rejectThreeDecimal(field, code);
  const units = BigInt(amount);
  const magnitude = absolute && units < 0n ? -units : units;
  return fromUnits(magnitude * (CHARGEBEE_ZERO_DECIMAL.has(code) ? 10_000n : 100n));
}

/** Pure: roll line-level amounts into batch totals. */
export function summarizeSettlement(lines: ParsedSettlementLine[]): {
  grossAmount: string;
  feeAmount: string;
  refundAmount: string;
  disputeAmount: string;
  adjustmentAmount: string;
  fxAmount: string;
  netAmount: string;
} {
  let gross = 0n;
  let fee = 0n;
  let refund = 0n;
  let dispute = 0n;
  let adjustment = 0n;
  let fx = 0n;
  for (const l of lines) {
    const u = toUnits(l.amount);
    switch (l.kind) {
      case "charge":
      case "transfer":
        gross += u;
        break;
      case "fee":
        // Signed: a fee reversal books as a negative fee line (a credit),
        // which nets off fee expense instead of adding to it. Plain fee
        // costs are positive, so every existing batch is unaffected.
        fee += u;
        break;
      case "refund":
        refund += u < 0n ? -u : u;
        break;
      case "adjustment":
        adjustment += u < 0n ? -u : u;
        break;
      case "dispute":
        dispute += u < 0n ? -u : u;
        break;
      case "dispute_reversal":
        dispute -= u < 0n ? -u : u;
        break;
      case "fx_adjustment":
        fx += u;
        break;
      default:
        gross += u;
    }
  }
  // Net = gross − fees − refunds − disputes − adjustments + fx, with the
  // dispute leg SIGNED: a reversal-heavy batch nets a negative dispute
  // (a credit back), never a clamped 0 that would strand the difference in
  // the clearing residual. There is no separate reversal account in the PSP
  // account model, so the net rides the dispute leg and its account.
  const net = gross - fee - refund - dispute - adjustment + fx;
  // The stored row must foot. This recomputes the identity from the same
  // accumulators, so it passes by construction today — it is a tripwire for
  // tomorrow: any future kind or sign change that breaks the identity
  // refuses the import by name instead of posting an unbalanced story.
  const footed = gross - fee - refund - dispute - adjustment + fx;
  if (footed !== net) {
    throw new PspSettlementError(
      `settlement totals do not foot: gross ${fromUnits(gross)} − fees ${fromUnits(fee)} − refunds ${fromUnits(refund)} − disputes ${fromUnits(dispute)} − adjustments ${fromUnits(adjustment)} + fx ${fromUnits(fx)} ≠ net ${fromUnits(net)}`,
    );
  }
  return {
    grossAmount: fromUnits(gross),
    feeAmount: fromUnits(fee),
    refundAmount: fromUnits(refund),
    disputeAmount: fromUnits(dispute),
    adjustmentAmount: fromUnits(adjustment),
    fxAmount: fromUnits(fx),
    netAmount: fromUnits(net),
  };
}

/**
 * Parser registry: adding a provider is one entry here (plus the CHECK
 * widening). The settlements route dispatches through this instead of
 * branching per provider, so a new provider cannot strand the route.
 */
export const SETTLEMENT_PARSERS: Record<PspProvider, { label: string; kinds: string }> = {
  stripe: { label: "Stripe", kinds: "balance transactions" },
  recurly: { label: "Recurly", kinds: "settlement payload" },
  chargebee: { label: "Chargebee", kinds: "settlement payload" },
  shopify_payments: { label: "Shopify Payments", kinds: "payout and balance transactions" },
  paypal: { label: "PayPal", kinds: "transaction search export or settlement CSV" },
  square: { label: "Square", kinds: "payout and payout entries" },
};
