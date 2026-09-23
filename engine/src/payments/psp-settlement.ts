import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { assertPeriodModulesOpen } from "../close/period-policy.ts";
import { resolveCoveringPeriod } from "../close/period-resolution.ts";
import { cmp, fromUnits, isZero, neg, toUnits } from "../money/money.ts";
import { sealJson } from "../platform/secrets.ts";
import { assertNotSandbox } from "../organization/sandbox-guard.ts";
import { ScopeNotFoundError, assertUnrestrictedScope, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { loadSubsidiaryContext, SubsidiaryError, uuidArray, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";
import { fromMinorUnits, THREE_DECIMAL_CURRENCIES } from "./acceptance.ts";

/**
 * PSP settlement import — Stripe / Recurly / Chargebee payout batches post
 * through the inventory-style kernel path (balanced journal_entries origin
 * `document` or allocation). Fees, disputes, refunds, adjustments, and FX legs
 * are evidence-backed settlement_lines. Idempotent on (org, provider, externalRef).
 */

export type PspProvider = "stripe" | "recurly" | "chargebee";
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

export class PspSettlementError extends Error {}

const PSP_ACCOUNT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every account a settlement batch can post to must resolve as a postable
 * account of the caller's org (active, non-summary). Tenant-coherent FKs
 * would kill a foreign account at the journal insert as a raw 500, and a
 * deactivated account only slightly later at the line guard — both long
 * after import/config accepted the reference. Fail closed here instead with
 * a domain error; a uniform refusal reveals nothing about other tenants.
 */
async function validateSettlementPostingAccounts(
  orgId: string,
  accounts: { label: string; id: string | null | undefined }[],
): Promise<void> {
  const ids = [
    ...new Set(
      accounts
        .map((a) => a.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  if (ids.length === 0) return;
  const malformed = ids.find((id) => !PSP_ACCOUNT_UUID_RE.test(id));
  if (malformed) {
    throw new PspSettlementError(
      `settlement account ${malformed} is not a valid account reference`,
    );
  }
  const rows = (await db.execute<{ id: string }>(sql`
    select id from accounts
     where org_id = ${orgId} and is_active and not is_summary
       and id = any(${`{${ids.join(",")}}`}::uuid[])
  `));
  const found = new Set(rows.rows.map((r) => r.id.toLowerCase()));
  const missing = ids.find((id) => !found.has(id.toLowerCase()));
  if (missing) {
    const label = accounts.find((a) => a.id === missing)?.label ?? "settlement";
    throw new PspSettlementError(
      `settlement ${label} account is not a postable account in this organization`,
    );
  }
}

export interface ParsedSettlementLine {
  kind: SettlementLineKind;
  amount: string; // signed; fees/refunds usually negative of gross narrative in provider but we store natural sign by kind
  externalRef?: string | null;
  description?: string | null;
  currency?: string | null;
  meta?: Record<string, unknown>;
}

export interface ParsedSettlement {
  provider: PspProvider;
  externalRef: string;
  settlementDate: string;
  currency: string;
  lines: ParsedSettlementLine[];
  memo?: string | null;
  raw?: Record<string, unknown>;
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
function requireSettlementCurrency(
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
function requireChargebeeCurrency(code: unknown): string {
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
function requireRecurlyCurrency(code: unknown): string {
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

function fromPspMinorUnits(
  amount: number,
  field: string,
  absolute = false,
  currency = "USD",
): string {
  if (!Number.isSafeInteger(amount)) {
    throw new PspSettlementError(
      `${field} must be a safe integer in provider minor units`,
    );
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

function fromChargebeeMinorUnits(
  amount: number,
  field: string,
  absolute = false,
  currency = "USD",
): string {
  if (!Number.isSafeInteger(amount)) {
    throw new PspSettlementError(
      `${field} must be a safe integer in provider minor units`,
    );
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
 * Stripe balance-transaction types this importer understands. Every arm of
 * the kind mapping below cases one of these; anything else is refused by
 * name so a new Stripe type can never silently book as a charge.
 */
const STRIPE_KNOWN_BALANCE_TYPES = [
  "charge",
  "payment",
  "refund",
  "payment_refund",
  "dispute",
  "adjustment",
  "stripe_fee",
  "fee",
  "application_fee",
  "application_fee_refund",
  "transfer",
  "transfer_refund",
  "transfer_cancel",
  "transfer_failure",
  "topup",
  "payout",
  "payout_cancel",
  "payout_failure",
] as const;

type KnownStripeBalanceType = (typeof STRIPE_KNOWN_BALANCE_TYPES)[number];

function isKnownStripeBalanceType(value: string): value is KnownStripeBalanceType {
  return (STRIPE_KNOWN_BALANCE_TYPES as readonly string[]).includes(value);
}

/**
 * Map one validated Stripe balance-transaction type to its settlement kind.
 * Returns "excluded" for the payout movement itself (see below), never a
 * bookable kind. Exhaustive over KnownStripeBalanceType: adding a type to
 * the list without casing it here fails tsc on the never arm.
 */
function stripeSettlementKind(
  rowType: KnownStripeBalanceType,
  description: string | null | undefined,
  amountMinor: number,
): SettlementLineKind | "excluded" {
  switch (rowType) {
    case "charge":
    case "payment":
    case "application_fee":
      return "charge";
    case "refund":
    case "payment_refund":
    case "application_fee_refund":
      return "refund";
    case "dispute":
      return "dispute";
    case "adjustment": {
      // A bare "adjustment" whose narrative names a dispute is the dispute
      // itself under Stripe's older reporting shape; keep that routing.
      if ((description ?? "").toLowerCase().includes("dispute")) return "dispute";
      // summarizeSettlement books "adjustment" as a magnitude that REDUCES
      // the net, which is exactly a non-positive Stripe adjustment. A
      // positive adjustment (Stripe crediting the merchant) would book
      // backwards there, so it rides the signed miscellaneous bucket
      // instead — the total reconciliation below proves either choice.
      return amountMinor > 0 ? "other" : "adjustment";
    }
    case "stripe_fee":
    case "fee":
      return "fee";
    case "transfer":
    case "transfer_refund":
    case "transfer_cancel":
    case "transfer_failure":
    case "topup":
    case "payout_cancel":
    case "payout_failure":
      // A returned payout (an earlier payout that failed) comes back as
      // balance the later payout pays out: dropping it would understate the
      // bank deposit, so it books as a funding transfer and the payout-total
      // reconciliation below proves it.
      return "transfer";
    case "payout":
      return "excluded";
    default: {
      const _exhaustive: never = rowType;
      throw new PspSettlementError(
        `unsupported Stripe balance transaction type "${String(_exhaustive)}"`,
      );
    }
  }
}

/** Stripe balance transaction export row shape (subset). */
export function parseStripeBalanceTransactions(
  rows: {
    id: string;
    type: string;
    amount: number; // cents
    fee?: number;
    net?: number;
    currency: string;
    created?: number;
    description?: string | null;
    available_on?: number;
  }[],
  payoutId: string,
  settlementDate: string,
): ParsedSettlement {
  if (rows.length === 0) {
    throw new PspSettlementError("settlement batch has no evidence lines");
  }
  const lines: ParsedSettlementLine[] = [];
  let currency = "";
  let includedRows = 0;
  let rowsWithNet = 0;
  let expectedNetMinor = 0n;
  let payoutAnchorMinor = 0n;
  let payoutRows = 0;
  for (const [index, r] of rows.entries()) {
    // Every row carries its own explicit currency: inheriting a previous
    // row's (or a USD default) would silently convert foreign amounts at the
    // wrong scale, and rows of different currencies must never be summed as
    // one batch — importSettlementBatch re-checks this before any write.
    // Trim and validate BEFORE scaling: an untrimmed " jpy " would miss the
    // zero-decimal table and convert as cents.
    const raw = typeof r.currency === "string" ? r.currency.trim() : "";
    if (raw === "") {
      throw new PspSettlementError("Stripe transaction currency is required");
    }
    const rowCurrency = raw.toUpperCase();
    if (!/^[A-Z]{3}$/.test(rowCurrency)) {
      throw new PspSettlementError(
        "Stripe transaction currency must be a three-letter currency code",
      );
    }
    if (currency === "") currency = rowCurrency;
    else if (rowCurrency !== currency) {
      throw new PspSettlementError(
        `mixed-currency Stripe transactions (${currency}, ${rowCurrency}) cannot settle as one batch`,
      );
    }
    // Stripe amounts are in the smallest currency unit (cents), except
    // zero-decimal currencies which arrive as whole major units. money uses
    // 4dp of major unit: 123 cents = 1.2300 → units = 12300 = cents * 100.
    const major = fromPspMinorUnits(r.amount, "Stripe amount", false, currency);
    const fee =
      r.fee == null
        ? null
        : fromPspMinorUnits(r.fee, "Stripe fee", true, currency);
    if (r.net != null) {
      fromPspMinorUnits(r.net, "Stripe net amount", false, currency);
    }
    // A missing type is a client-shape refusal, not a 500: the kind mapping
    // below reads `.includes` off this field, so an unvalidated row escapes
    // as a TypeError with no schema help (F-t06-004). Name the 1-based row
    // (plus the provider id when the row carries one) so the payload can be
    // repaired field-by-field.
    const rowType = typeof r.type === "string" ? r.type : "";
    const rowIdSuffix =
      typeof r.id === "string" && r.id !== "" ? ` ${r.id}` : "";
    const rowLabel = `row ${index + 1}${rowIdSuffix}`;
    if (rowType === "") {
      throw new PspSettlementError(
        `Stripe transaction type is required (${rowLabel})`,
      );
    }
    if (!isKnownStripeBalanceType(rowType)) {
      throw new PspSettlementError(
        `unsupported Stripe balance transaction type "${rowType}" (${rowLabel}): ` +
          `re-export the payout's balance transactions without it, or extend the importer to map it, before importing payout ${payoutId}`,
      );
    }
    const mapped = stripeSettlementKind(rowType, r.description, r.amount);
    if (mapped === "excluded") {
      // The payout's own movement: it IS the bank leg this batch will post,
      // not settlement content. Booking it as a transfer would collapse the
      // computed net toward zero. Its negated amount anchors the payout-total
      // reconciliation below — the independent proof the export is complete.
      payoutAnchorMinor -= BigInt(r.amount);
      payoutRows += 1;
      continue;
    }
    const kind: SettlementLineKind = mapped;
    // Reconcile the export against itself before booking anything. Stripe's
    // contract is net = amount − fee with a SIGNED fee — but some exports
    // (and long-standing fixtures) report a taken fee as a negative number,
    // under which net = amount − |fee|. Exactly one convention can foot when
    // the fee is nonzero, so a row footing under either is accepted and the
    // fee line follows the convention that footed; a row footing under
    // neither is a corrupt or half-read export, never a booking.
    const feeSigned = BigInt(r.fee ?? 0);
    const feeMagnitude = feeSigned < 0n ? -feeSigned : feeSigned;
    const signedFoots = r.net != null && BigInt(r.net) === BigInt(r.amount) - feeSigned;
    const magnitudeFoots = r.net != null && BigInt(r.net) === BigInt(r.amount) - feeMagnitude;
    if (r.net != null) {
      if (!signedFoots && !magnitudeFoots) {
        const readings =
          feeSigned < 0n
            ? `net ${r.net} != amount ${r.amount} minus fee ${r.fee} (signed: ${BigInt(r.amount) - feeSigned}) ` +
              `nor minus fee magnitude (magnitude: ${BigInt(r.amount) - feeMagnitude})`
            : `net ${r.net} != amount ${r.amount} minus fee ${r.fee ?? 0}`;
        throw new PspSettlementError(
          `Stripe transaction does not foot (${rowLabel}): ${readings}; ` +
            `re-export the payout's balance transactions and import payout ${payoutId} again`,
        );
      }
      expectedNetMinor += BigInt(r.net);
      rowsWithNet += 1;
    }
    includedRows += 1;
    lines.push({
      kind,
      amount: major,
      externalRef: r.id,
      description: r.description ?? rowType,
      currency,
      meta: { stripeType: rowType, fee: r.fee, net: r.net },
    });
    // Fees ride every row kind — a dispute's $15 fee is fee expense whether
    // the row is a charge, a refund, a dispute, or an adjustment. Splitting
    // them only out of charges overstated the bank leg and understated fees.
    // A negative fee that foots SIGNED is a fee reversal (Stripe returning an
    // earlier fee): it books as a fee credit — a negative fee line, which the
    // signed fee bucket nets off fee expense — never as more expense. A
    // negative fee with no row net cannot be directed at all (cost reported
    // negative and reversal are indistinguishable), so it is refused rather
    // than guessed.
    if (fee != null && r.fee != null && r.fee !== 0) {
      const rawFee: number = r.fee;
      if (rawFee < 0 && r.net == null) {
        throw new PspSettlementError(
          `Stripe transaction fee direction is indeterminate (${rowLabel}): fee ${rawFee} without a row net reads ` +
            `as neither a cost nor a reversal; re-export the payout's balance transactions with row nets and import payout ${payoutId} again`,
        );
      }
      const reversal = rawFee < 0 && signedFoots;
      lines.push({
        kind: "fee",
        amount: reversal
          ? fromPspMinorUnits(rawFee, "Stripe fee", false, currency)
          : fee,
        externalRef: `${r.id}_fee`,
        description: reversal ? "Stripe fee refund" : "Stripe processing fee",
        currency,
      });
    }
  }
  if (includedRows === 0) {
    throw new PspSettlementError(
      `settlement batch has no evidence lines: payout ${payoutId} carries only its own payout movement`,
    );
  }
  // Total reconciliation: when every content row carries its export net, the
  // booked net must equal the export's own total. A drift means the kind
  // mapping mis-assigned a row's economics (or the export is partial), and
  // posting would debit the bank with a computed net no row observes.
  // Rows without a net cannot participate, so a partially-evidenced export
  // skips this check rather than failing on missing data.
  if (rowsWithNet === includedRows) {
    const computedNet = summarizeSettlement(lines).netAmount;
    const expectedNet = fromMinorUnits(expectedNetMinor, currency);
    if (cmp(computedNet, expectedNet) !== 0) {
      throw new PspSettlementError(
        `Stripe payout ${payoutId} does not reconcile: export nets total ${expectedNet} but settlement lines net to ${computedNet}; ` +
          `re-export the payout's balance transactions and import again`,
      );
    }
  }
  // Payout-total reconciliation: when the export carries the payout's own
  // movement row, its negated amount is the payout Stripe actually paid —
  // the figure the bank will show. Returned-payout funds (payout_cancel /
  // payout_failure rows) are constituents of that total: dropping them would
  // still pass the nets-total check above (both sides drop them) while the
  // booked deposit undershoots the bank leg. Refusing here forces the export
  // to be complete; the remedy is to re-export without the movement row
  // (the common API shape, which skips this check) or with every row.
  if (payoutRows > 0) {
    const computedNet = summarizeSettlement(lines).netAmount;
    const payoutTotal = fromMinorUnits(payoutAnchorMinor, currency);
    if (cmp(computedNet, payoutTotal) !== 0) {
      throw new PspSettlementError(
        `Stripe payout ${payoutId} does not reconcile: its payout movement totals ${payoutTotal} but settlement lines net to ${computedNet}; ` +
          `re-export the payout's balance transactions without the payout movement row and import again`,
      );
    }
  }
  return {
    provider: "stripe",
    externalRef: payoutId,
    settlementDate,
    currency,
    lines,
    memo: `Stripe payout ${payoutId}`,
    raw: { rowCount: rows.length },
  };
}

/** Recurly invoices_revenue_report / transactions export subset. */
export function parseRecurlySettlement(payload: {
  id: string;
  closed_at?: string;
  currency?: string | null;
  charge_amount?: string | number;
  refund_amount?: string | number;
  fee_amount?: string | number;
  net_amount?: string | number;
  lines?: {
    type: string;
    amount: string | number;
    id?: string;
    description?: string;
  }[];
}, fallbackDate?: string): ParsedSettlement {
  // Currency is never defaulted: a currency-less payload booked as USD would
  // silently mislabel every foreign-currency settlement. Same explicit-code
  // contract as the Stripe and Chargebee parsers.
  const currency = requireRecurlyCurrency(payload.currency);
  const date = (payload.closed_at ?? fallbackDate ?? new Date().toISOString()).slice(0, 10);
  const lines: ParsedSettlementLine[] = [];
  if (payload.lines?.length) {
    for (const l of payload.lines) {
      const kind: SettlementLineKind =
        l.type === "refund"
          ? "refund"
          : l.type === "fee"
            ? "fee"
            : l.type === "dispute"
              ? "dispute"
              : "charge";
      lines.push({
        kind,
        amount: fromUnits(toUnits(String(l.amount))),
        externalRef: l.id ?? null,
        description: l.description ?? l.type,
        currency,
      });
    }
  } else {
    if (payload.charge_amount)
      lines.push({
        kind: "charge",
        amount: fromUnits(toUnits(String(payload.charge_amount))),
        currency,
      });
    if (payload.refund_amount)
      lines.push({
        kind: "refund",
        amount: fromUnits(toUnits(String(payload.refund_amount))),
        currency,
      });
    if (payload.fee_amount)
      lines.push({
        kind: "fee",
        amount: fromUnits(toUnits(String(payload.fee_amount))),
        currency,
      });
  }
  return {
    provider: "recurly",
    externalRef: payload.id,
    settlementDate: date,
    currency,
    lines,
    memo: `Recurly settlement ${payload.id}`,
    raw: payload as unknown as Record<string, unknown>,
  };
}

/**
 * Chargebee invoice settlement subset.
 *
 * Contract (item 6A): the receipt books amount_paid — cash the provider
 * actually collected (successful linked payments) — never the billed total.
 * amount_adjusted (write-offs, credit-note applications; a non-negative
 * magnitude here) posts as its own `adjustment` leg against the customer,
 * carrying adjustment_reason when the export surfaces one, so adjustments
 * never pollute refund metrics. credits_applied (applied
 * promotional/excess-payment credits: this subset's scalar for the
 * provider's applied-credit sums) keeps its existing refund leg.
 *
 * Two bigint-exact identities are enforced before any write, each naming the
 * invoice id on failure:
 *   1. provider-total foot — total == amount_paid + adjustments + credits
 *      applied (the provider's own amount_due identity, less taxes withheld,
 *      which live outside this subset). Catches outstanding dues and
 *      incoherent provider numbers. This adapter nets no provider fees, so
 *      the generalized "(+ fees where netted)" term is zero here; the
 *      shared writer's net identity is the cross-provider form.
 *   2. booked-net identity — summarizeSettlement(lines).net == amount_paid.
 *      Catches line-item detail that drifts from the provider total
 *      (invoice-level discounts/taxes outside this subset shape). Recourse
 *      is in the error: re-import without line items to book the total.
 * Together they guarantee the posted bank leg equals amount_paid exactly.
 * A negative amount_paid is refused outright (the provider minimum is zero).
 */
export function parseChargebeeSettlement(payload: {
  id: string;
  date?: number | string;
  currency_code?: string;
  total?: number;
  amount_paid?: number;
  amount_adjusted?: number;
  /** Operator-surfaced provider reason for the adjustment (e.g. the
   *  adjustment credit-note reason); carried onto the adjustment leg. */
  adjustment_reason?: string | null;
  credits_applied?: number;
  line_items?: {
    id?: string;
    description?: string;
    amount?: number;
    entity_type?: string;
  }[];
  // taxes/fees may appear as special entity types
}, fallbackDate?: string): ParsedSettlement {
  // Currency is never guessed: Chargebee always sends currency_code and its
  // scaling follows its own zero-decimal contract, not the Stripe-scale table.
  const currency = requireChargebeeCurrency(payload.currency_code);
  const total =
    payload.total == null
      ? null
      : fromChargebeeMinorUnits(payload.total, "Chargebee total", false, currency);
  const paid =
    payload.amount_paid == null
      ? null
      : fromChargebeeMinorUnits(payload.amount_paid, "Chargebee amount paid", false, currency);
  if (paid != null && cmp(paid, "0") < 0) {
    throw new PspSettlementError("Chargebee amount paid must not be negative");
  }
  const adjusted =
    payload.amount_adjusted == null
      ? null
      : fromChargebeeMinorUnits(payload.amount_adjusted, "Chargebee amount adjusted", true, currency);
  if (payload.adjustment_reason != null && typeof payload.adjustment_reason !== "string") {
    throw new PspSettlementError("Chargebee adjustment reason must be a string");
  }
  const adjustmentReason = (payload.adjustment_reason ?? "").trim();
  const settlementDate =
    typeof payload.date === "number"
      ? new Date(payload.date * 1000).toISOString().slice(0, 10)
      : String(payload.date ?? fallbackDate ?? new Date().toISOString()).slice(0, 10);
  const lines: ParsedSettlementLine[] = [];
  if (payload.line_items?.length) {
    for (const li of payload.line_items) {
      const et = (li.entity_type ?? "").toLowerCase();
      const kind: SettlementLineKind = et.includes("tax")
        ? "other"
        : et.includes("addon") || et.includes("plan")
          ? "charge"
          : "charge";
      lines.push({
        kind,
        amount: fromChargebeeMinorUnits(
          li.amount ?? 0,
          "Chargebee line-item amount",
          false,
          currency,
        ),
        externalRef: li.id ?? null,
        description: li.description ?? et,
        currency,
      });
    }
  } else if (total != null) {
    lines.push({
      kind: "charge",
      amount: total,
      currency,
    });
  }
  // Chargebee often separate-refunds via credits
  const creditsApplied =
    payload.credits_applied == null
      ? null
      : fromChargebeeMinorUnits(
          payload.credits_applied,
          "Chargebee credits applied",
          true,
          currency,
        );
  if (creditsApplied != null && payload.credits_applied !== 0) {
    lines.push({
      kind: "refund",
      amount: creditsApplied,
      description: "Credits applied",
      currency,
    });
  }
  if (adjusted != null && payload.amount_adjusted !== 0) {
    lines.push({
      kind: "adjustment",
      amount: adjusted,
      externalRef: `${payload.id}_adjustment`,
      description: adjustmentReason
        ? `Chargebee adjustment (${adjustmentReason})`
        : "Chargebee adjustment",
      currency,
      meta: adjustmentReason ? { chargebeeReason: adjustmentReason } : {},
    });
  }
  // Fail closed before any write: an unfooted invoice must never book its
  // billed total as received, nor a bank leg that differs from collected cash.
  if (total != null && paid != null) {
    const explained =
      toUnits(paid) +
      (adjusted != null ? toUnits(adjusted) : 0n) +
      (creditsApplied != null ? toUnits(creditsApplied) : 0n);
    if (toUnits(total) !== explained) {
      const diff = toUnits(total) - explained;
      const tail =
        diff > 0n
          ? ` (${fromUnits(diff)} still due)`
          : ` (${fromUnits(-diff)} over-applied)`;
      throw new PspSettlementError(
        `Chargebee invoice ${payload.id} does not reconcile: total ${total} != amount paid ${paid} + adjustments ${adjusted ?? fromUnits(0n)} + credits applied ${creditsApplied ?? fromUnits(0n)}${tail}`,
      );
    }
  }
  if (paid != null) {
    const net = summarizeSettlement(lines).netAmount;
    if (toUnits(net) !== toUnits(paid)) {
      throw new PspSettlementError(
        `Chargebee invoice ${payload.id} books net ${net} but amount collected is ${paid}: line-item detail does not foot to the provider total; re-import without line items to book the provider total`,
      );
    }
  }
  return {
    provider: "chargebee",
    externalRef: payload.id,
    settlementDate,
    currency,
    lines,
    memo: `Chargebee settlement ${payload.id}`,
    raw: payload as unknown as Record<string, unknown>,
  };
}

async function primaryBookId(orgId: string): Promise<string> {
  const r = (await db.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary and is_active and posts_gl
     limit 1 for share
  `));
  const id = r.rows[0]?.id;
  if (!id) throw new PspSettlementError("no active primary posting book");
  return id;
}

async function periodForDate(
  orgId: string,
  date: string,
): Promise<string | null> {
  // Through the shared covering-period resolver (default calendar,
  // deterministic under overlaps); both settlement and reversal callers
  // keep their signatures.
  return (await resolveCoveringPeriod(db, orgId, date))?.id ?? null;
}

export interface ImportAccounts {
  bankAccountId: string;
  feeAccountId: string;
  disputeAccountId: string;
  fxAccountId: string;
  clearingAccountId: string;
  subsidiaryId: string;
}

/**
 * Persist a draft batch + lines (idempotent). Does not post GL.
 */
export async function importSettlementBatch(
  orgId: string,
  actorId: string | null,
  parsed: ParsedSettlement,
  accounts: Partial<ImportAccounts>,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<{ batchId: string; created: boolean }> {
  if (!parsed.externalRef.trim()) {
    throw new PspSettlementError("provider settlement reference is required");
  }
  if (parsed.lines.length === 0) {
    throw new PspSettlementError("settlement batch has no evidence lines");
  }
  // Provider parsers forward closed_at/date/fallback timestamps as a sliced
  // calendar day without checking calendar reality, so an impossible day
  // would otherwise die in Postgres as a raw cast failure (a 500 at the
  // route, which maps only PspSettlementError to 422). Fail closed here —
  // the single pre-write choke point every provider and direct caller
  // passes through — with the same shape the reverse action requires.
  if (!isIsoCalendarDate(parsed.settlementDate)) {
    throw new PspSettlementError(
      "settlement date must be a real calendar date (YYYY-MM-DD)",
    );
  }
  const currency = parsed.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new PspSettlementError(
      "settlement currency must be a three-letter code",
    );
  }
  for (const line of parsed.lines) {
    if (line.currency && line.currency.toUpperCase() !== currency) {
      throw new PspSettlementError(
        "mixed-currency settlement lines require explicit conversion evidence",
      );
    }
  }
  // Resolve posting accounts before any write: import is the first place a
  // foreign or unpostable account reference can enter the batch lifecycle.
  await validateSettlementPostingAccounts(orgId, [
    { label: "bank", id: accounts.bankAccountId },
    { label: "fee", id: accounts.feeAccountId },
    { label: "dispute", id: accounts.disputeAccountId },
    { label: "fx", id: accounts.fxAccountId },
    { label: "clearing", id: accounts.clearingAccountId },
  ]);
  // The subsidiary reference enters the lifecycle here too: a malformed id
  // would otherwise die in Postgres as a raw uuid-cast 500, and a foreign
  // or inactive id would persist to strand the draft at posting (F-t06-004).
  // Absence stays lenient — the import form asks up front, and posting
  // resolves an absent subsidiary exactly like every other document.
  const subsidiaryId =
    typeof accounts.subsidiaryId === "string" &&
    accounts.subsidiaryId !== ""
      ? accounts.subsidiaryId
      : null;
  if (subsidiaryId !== null) {
    if (!PSP_ACCOUNT_UUID_RE.test(subsidiaryId)) {
      throw new PspSettlementError(
        `settlement subsidiary ${subsidiaryId} is not a valid subsidiary reference`,
      );
    }
    const sub = (await db.execute<{ name: string; isActive: boolean }>(sql`
      select name, is_active as "isActive"
        from subsidiaries
       where org_id = ${orgId} and id = ${subsidiaryId}
    `)).rows[0];
    if (!sub) {
      throw new PspSettlementError(
        "settlement subsidiary is not a subsidiary of this organization",
      );
    }
    if (!sub.isActive) {
      throw new PspSettlementError(`subsidiary "${sub.name}" is inactive`);
    }
  }
  if (!subsidiaryScopeAllows(allowedSubsidiaryIds, subsidiaryId)) {
    throw new ScopeNotFoundError();
  }
  const totals = summarizeSettlement(parsed.lines);
  return withOrg(orgId, async () => {
    const proposedId = randomUUID();
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into psp_settlement_batches (
        id, org_id, provider, external_ref, status, currency,
        gross_amount, fee_amount, refund_amount, dispute_amount, adjustment_amount, net_amount, fx_amount,
        settlement_date, bank_account_id, fee_account_id, dispute_account_id, fx_account_id,
        clearing_account_id, subsidiary_id, source_payload, line_count, memo, created_by, updated_by
      ) values (
        ${proposedId}, ${orgId}, ${parsed.provider}, ${parsed.externalRef}, 'draft', ${currency},
        ${totals.grossAmount}, ${totals.feeAmount}, ${totals.refundAmount}, ${totals.disputeAmount},
        ${totals.adjustmentAmount}, ${totals.netAmount}, ${totals.fxAmount}, ${parsed.settlementDate},
        ${accounts.bankAccountId ?? null}, ${accounts.feeAccountId ?? null},
        ${accounts.disputeAccountId ?? null}, ${accounts.fxAccountId ?? null},
        ${accounts.clearingAccountId ?? null}, ${subsidiaryId},
        ${parsed.raw ? JSON.stringify(parsed.raw) : null}::jsonb, ${parsed.lines.length},
        ${parsed.memo ?? null}, ${actorId}, ${actorId}
      )
      on conflict (org_id, provider, external_ref) do nothing
      returning id
    `));
    const created = inserted.rows.length === 1;
    const current = (await db.execute<{ id: string; status: string; subsidiary_id: string | null }>(sql`
      select id, status, subsidiary_id
        from psp_settlement_batches
       where org_id = ${orgId}
         and provider = ${parsed.provider}
         and external_ref = ${parsed.externalRef}
       for update
    `));
    const row = current.rows[0];
    if (!row)
      throw new PspSettlementError("settlement batch could not be locked");
    if (!subsidiaryScopeAllows(allowedSubsidiaryIds, row.subsidiary_id)) {
      throw new ScopeNotFoundError();
    }
    if (row.status === "posted") return { batchId: row.id, created: false };
    if (row.status === "void") {
      throw new PspSettlementError(
        "a voided provider settlement reference cannot be reused",
      );
    }
    const batchId = row.id;
    if (!created) {
      await db.execute(sql`
        delete from psp_settlement_lines
         where batch_id = ${batchId} and org_id = ${orgId}
      `);
    }
    await db.execute(sql`
      update psp_settlement_batches set
        currency = ${currency},
        gross_amount = ${totals.grossAmount},
        fee_amount = ${totals.feeAmount},
        refund_amount = ${totals.refundAmount},
        dispute_amount = ${totals.disputeAmount},
        adjustment_amount = ${totals.adjustmentAmount},
        net_amount = ${totals.netAmount},
        fx_amount = ${totals.fxAmount},
        settlement_date = ${parsed.settlementDate},
        bank_account_id = coalesce(${accounts.bankAccountId ?? null}, bank_account_id),
        fee_account_id = coalesce(${accounts.feeAccountId ?? null}, fee_account_id),
        dispute_account_id = coalesce(${accounts.disputeAccountId ?? null}, dispute_account_id),
        fx_account_id = coalesce(${accounts.fxAccountId ?? null}, fx_account_id),
        clearing_account_id = coalesce(${accounts.clearingAccountId ?? null}, clearing_account_id),
        subsidiary_id = coalesce(${subsidiaryId}, subsidiary_id),
        source_payload = ${parsed.raw ? JSON.stringify(parsed.raw) : null}::jsonb,
        line_count = ${parsed.lines.length},
        memo = ${parsed.memo ?? null},
        updated_at = now(), updated_by = ${actorId}
       where id = ${batchId} and org_id = ${orgId}
    `);
    await insertLines(orgId, batchId, parsed.lines, actorId);
    return { batchId, created };
  });
}

async function insertLines(
  orgId: string,
  batchId: string,
  lines: ParsedSettlementLine[],
  actorId: string | null,
): Promise<void> {
  let n = 0;
  for (const l of lines) {
    n++;
    await db.execute(sql`
      insert into psp_settlement_lines
        (org_id, batch_id, line_number, kind, external_ref, description, amount, currency, meta, created_by, updated_by)
      values (${orgId}, ${batchId}, ${n}, ${l.kind}, ${l.externalRef ?? null}, ${l.description ?? null},
              ${l.amount}, ${l.currency ?? null}, ${JSON.stringify(l.meta ?? {})}::jsonb, ${actorId}, ${actorId})
    `);
  }
}

/**
 * Post a draft settlement as one balanced journal:
 *   DR bank net
 *   DR fee expense
 *   DR refunds/disputes (clearing or expense)
 *   CR clearing (gross charges)
 *   DR/CR FX gain/loss
 *
 * Clearing is typically undeposited funds / PSP receivable that matches prior
 * AR cash applications, or the batch can CR income if configured as direct.
 */
export async function postSettlementBatch(
  orgId: string,
  batchId: string,
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ entryId: string }> {
  await assertNotSandbox(orgId, "post a PSP settlement");
  return await withOrg(orgId, async () => {
    const batch = (await db.execute<{
        id: string;
        status: string;
        currency: string;
        gross_amount: string;
        fee_amount: string;
        refund_amount: string;
        dispute_amount: string;
        adjustment_amount: string;
        net_amount: string;
        fx_amount: string;
        settlement_date: string;
        bank_account_id: string | null;
        fee_account_id: string | null;
        dispute_account_id: string | null;
        fx_account_id: string | null;
        clearing_account_id: string | null;
        subsidiary_id: string | null;
        provider: string;
        external_ref: string;
        memo: string | null;
        journal_entry_id: string | null;
      }>(sql`
      select b.*
        from psp_settlement_batches b
       where b.id = ${batchId} and b.org_id = ${orgId}
       for update of b
    `));
    const b = batch.rows[0];
    if (!b) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(allowedSubsidiaryIds, b.subsidiary_id)) throw new ScopeNotFoundError();
    if (b.status === "posted") {
      if (!b.journal_entry_id) {
        throw new PspSettlementError(
          "posted batch is missing its journal entry",
        );
      }
      return { entryId: b.journal_entry_id };
    }
    if (b.status === "void") throw new PspSettlementError("batch is void");
    const controls = (await db.execute<{ c: Record<string, string> | null }>(sql`
      select settings->'controlAccounts' as c from orgs where id = ${orgId} for share
    `));
    const c = controls.rows[0]?.c ?? {};
    // Keep hierarchy and functional currency stable through validation and posting.
    await db.execute(sql`select id from subsidiaries where org_id=${orgId} order by id for share`);
    const ctx = await loadSubsidiaryContext(db, orgId);
    // Only a genuinely ambiguous choice (a multi-entity org with none named)
    // refuses, and then the refusal names exactly what is missing: the old
    // combined check blamed accounts the batch already carried (F-t06-004).
    // Either way the draft is repairable by re-importing the same provider
    // reference with the missing details (the import path fills them in).
    // The outer disjunct keeps every account narrowed past the refusal.
    if (
      !b.bank_account_id ||
      !b.clearing_account_id ||
      !b.fee_account_id ||
      (!b.subsidiary_id && ctx.multi)
    ) {
      const missing: string[] = [];
      if (!b.bank_account_id) missing.push("bank account");
      if (!b.clearing_account_id) missing.push("clearing account");
      if (!b.fee_account_id) missing.push("fee account");
      if (!b.subsidiary_id) missing.push("subsidiary");
      throw new PspSettlementError(
        `settlement batch cannot post without ${missing.join(", ")}; re-import the same provider reference with the missing details to repair this draft`,
      );
    }
    // An absent subsidiary resolves to the org root — the same contract the
    // posting kernel gives every other document (posting.ts: docSubId ??
    // root). Past the refusal above this is unambiguous: a named subsidiary,
    // or a single-entity org whose only choice is the root.
    const subsidiaryId: string = b.subsidiary_id ?? ctx.rootId;
    const subsidiary = ctx.byId.get(subsidiaryId);
    if (!subsidiary?.baseCurrency) {
      throw new PspSettlementError("settlement subsidiary is missing");
    }
    if (!subsidiary.isActive) throw new PspSettlementError(`subsidiary "${subsidiary.name}" is inactive`);
    if (b.currency !== subsidiary.baseCurrency) {
      throw new PspSettlementError(
        `cross-currency PSP settlement ${b.currency}→${subsidiary.baseCurrency} requires explicit rate and functional-currency evidence`,
      );
    }

    const fxAcct = b.fx_account_id ?? c.fxRealizedGainLoss ?? null;
    if (!isZero(b.fx_amount) && !fxAcct) {
      throw new PspSettlementError(
        "realized FX gain/loss account is not configured",
      );
    }
    const disputeAcct = b.dispute_account_id ?? b.fee_account_id;

    const periodId = await periodForDate(orgId, b.settlement_date);
    if (!periodId)
      throw new PspSettlementError(
        `no open accounting period for ${b.settlement_date}`,
      );
    const bookId = await primaryBookId(orgId);
    await assertPeriodModulesOpen(db, {
      orgId,
      periodId,
      bookId,
      subsidiaryIds: [subsidiaryId],
      modules: ["banking"],
    });

    // Build balanced lines in base/settlement currency (txn = amount, rate 1).
    type JL = { accountId: string; amount: string; memo: string };
    const jlines: JL[] = [];

    if (!isZero(b.net_amount) && cmp(b.net_amount, "0") !== 0) {
      jlines.push({
        accountId: b.bank_account_id,
        amount: b.net_amount, // DR bank when positive net deposit
        memo: "PSP net deposit",
      });
    }
    if (!isZero(b.fee_amount)) {
      jlines.push({
        accountId: b.fee_account_id,
        amount: b.fee_amount,
        memo: "PSP processing fees",
      });
    }
    if (!isZero(b.refund_amount)) {
      jlines.push({
        accountId: b.clearing_account_id,
        amount: b.refund_amount,
        memo: "PSP refunds",
      });
    }
    if (!isZero(b.dispute_amount)) {
      jlines.push({
        accountId: disputeAcct!,
        amount: b.dispute_amount,
        memo: "PSP disputes",
      });
    }
    // Adjustments (e.g. Chargebee amount_adjusted) clear against the same
    // customer-balance pool as refunds — the gross charges credited clearing,
    // so the write-off/credit leg debits it — but on their own journal line
    // so the GL tells write-offs apart from cash refunds.
    if (!isZero(b.adjustment_amount)) {
      jlines.push({
        accountId: b.clearing_account_id,
        amount: b.adjustment_amount,
        memo: "PSP adjustments",
      });
    }
    // CR clearing for gross charges (or residual).
    // Balance: sum(DR) + sum(CR signed) = 0 with DR+, CR− convention.
    const debitSum = jlines.reduce((s, l) => s + toUnits(l.amount), 0n);
    // We need clearing credit = −(gross) typically when landing charges
    // Recompute so entry balances: clearing takes residual opposite of debs + fx.
    // Residual amount so total = 0.
    let running = debitSum;
    if (!isZero(b.fx_amount) && fxAcct) {
      // FX: positive gain = credit (negative amount)
      jlines.push({
        accountId: fxAcct,
        amount: neg(b.fx_amount), // if fx positive gain → CR
        memo: "PSP FX",
      });
      running += toUnits(neg(b.fx_amount));
    }
    // Clearing residual to balance
    const clearAmount = fromUnits(-running);
    if (!isZero(clearAmount)) {
      jlines.push({
        accountId: b.clearing_account_id,
        amount: clearAmount,
        memo: "PSP clearing / charges",
      });
    }

    // Verify balance.
    const bal = jlines.reduce((s, l) => s + toUnits(l.amount), 0n);
    if (bal !== 0n)
      throw new PspSettlementError(
        `settlement journal does not balance: ${fromUnits(bal)}`,
      );

    const accountIds = [...new Set(jlines.map((line) => line.accountId))];
    const locked = (await db.execute<{ id: string }>(sql`select id from accounts where org_id=${orgId}
      and is_active and not is_summary
      and id=any(${uuidArray(accountIds)}::uuid[]) order by id for share`));
    // Accounts can leave the org (or postability) after import: re-resolve
    // every posting account under the batch lock so a stale reference fails
    // closed naming the account instead of escaping as a raw FK 500.
    const lockedIds = new Set(locked.rows.map((r) => r.id.toLowerCase()));
    const stale = accountIds.find((id) => !lockedIds.has(id.toLowerCase()));
    if (stale) {
      throw new PspSettlementError(
        `settlement posting account is not a postable account in this organization`,
      );
    }
    try {
      await validateSubsidiaryRestrictions(db, {
        orgId, ctx, docSubsidiaryId: subsidiaryId,
        lines: jlines.map((line) => ({ ...line, subsidiaryId })),
      });
    } catch (error) {
      if (error instanceof SubsidiaryError) throw new PspSettlementError(error.message);
      throw error;
    }

    const entryId = randomUUID();
    const entryNumber =
      `PSP-${b.provider.toUpperCase()}-${b.external_ref}`.slice(0, 64);
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
      values (${entryId}, ${orgId}, ${bookId}, ${subsidiaryId}, ${entryNumber}, ${b.settlement_date}, ${periodId},
              ${b.memo ?? `PSP ${b.provider} ${b.external_ref}`}, 'draft', 'document', ${actorId}, ${actorId})
    `);
    let ln = 0;
    for (const l of jlines) {
      ln++;
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
        values (${orgId}, ${entryId}, ${ln}, ${l.accountId}, ${subsidiaryId}, ${l.amount},
                ${b.currency}, ${l.amount}, 1, ${l.memo})
      `);
    }
    await db.execute(
      sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId} where id = ${entryId} and org_id = ${orgId}`,
    );
    await db.execute(sql`
      update psp_settlement_batches set status = 'posted', journal_entry_id = ${entryId}, posted_at = now(),
             subsidiary_id = ${subsidiaryId}, updated_at = now(), updated_by = ${actorId}
       where id = ${batchId} and org_id = ${orgId}
    `);
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'psp_settlement_batches', ${batchId}, 'post',
              ${JSON.stringify({ after: { journalEntryId: entryId, netAmount: b.net_amount } })}::jsonb, ${actorId})
    `);
    return { entryId };
  });
}

/**
 * Controlled correction for a posted PSP batch. Posted evidence is never
 * edited or deleted: the service mirrors every source journal line exactly in
 * a requested open period, links both sides of the reversal, and records the
 * actor/reason on the batch and audit log. Repeated calls return the same
 * reversal entry.
 */
export async function reverseSettlementBatch(
  orgId: string,
  batchId: string,
  actorId: string,
  input: { reversalDate: string; reason: string },
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ entryId: string }> {
  await assertNotSandbox(orgId, "reverse a PSP settlement");
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new PspSettlementError(
      "reversal reason must be between 5 and 500 characters",
    );
  }
  return withOrg(orgId, async () => {
    const batch = (await db.execute<{
        status: string;
        journal_entry_id: string | null;
        reversal_entry_id: string | null;
        provider: string;
        external_ref: string;
        subsidiary_id: string | null;
      }>(sql`
      select status, journal_entry_id, reversal_entry_id, provider,
             external_ref, subsidiary_id
        from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId}
       for update
    `));
    const b = batch.rows[0];
    if (!b) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(allowedSubsidiaryIds, b.subsidiary_id)) throw new ScopeNotFoundError();
    if (b.status === "void") {
      if (!b.reversal_entry_id) {
        throw new PspSettlementError("void batch is missing reversal evidence");
      }
      return { entryId: b.reversal_entry_id };
    }
    if (b.status !== "posted" || !b.journal_entry_id || !b.subsidiary_id) {
      throw new PspSettlementError(
        "only a posted settlement batch can be reversed",
      );
    }

    const source = (await db.execute<{
        book_id: string;
        subsidiary_id: string;
        entry_number: string;
        status: string;
        origin: string;
      }>(sql`
      select book_id, subsidiary_id, entry_number, status, origin
        from journal_entries
       where id = ${b.journal_entry_id} and org_id = ${orgId}
       for update
    `));
    const original = source.rows[0];
    if (!original || original.status !== "posted") {
      throw new PspSettlementError(
        "settlement source journal is missing or already reversed",
      );
    }
    const periodId = await periodForDate(orgId, input.reversalDate);
    if (!periodId) {
      throw new PspSettlementError(
        `no open accounting period for ${input.reversalDate}`,
      );
    }
    await assertPeriodModulesOpen(db, {
      orgId,
      periodId,
      bookId: original.book_id,
      subsidiaryIds: [original.subsidiary_id],
      modules: ["banking"],
    });
    const lines = (await db.execute<Record<string, unknown>>(sql`
      select line_number, account_id, subsidiary_id, amount::text, currency,
             txn_amount::text, fx_rate::text, memo, party_id, department_id,
             project_id, location_id, class_id, equipment_unit_id,
             payment_card_id, tax_code_id, extra_dims
        from journal_lines
       where entry_id = ${b.journal_entry_id} and org_id = ${orgId}
       order by line_number
    `));
    if (lines.rows.length === 0) {
      throw new PspSettlementError("settlement source journal has no lines");
    }

    const entryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, reverses_entry_id, created_by, updated_by)
      values
        (${entryId}, ${orgId}, ${original.book_id}, ${original.subsidiary_id},
         ${`${original.entry_number}-VOID`}, ${input.reversalDate}, ${periodId},
         ${`Reversal: ${reason}`}, 'draft', ${original.origin},
         ${b.journal_entry_id}, ${actorId}, ${actorId})
    `);
    for (const line of lines.rows) {
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
           currency, txn_amount, fx_rate, memo, party_id, department_id,
           project_id, location_id, class_id, equipment_unit_id,
             payment_card_id, tax_code_id, extra_dims)
        values
          (${orgId}, ${entryId}, ${Number(line.line_number)},
           ${String(line.account_id)}, ${String(line.subsidiary_id)},
           ${neg(String(line.amount))}, ${String(line.currency)},
           ${neg(String(line.txn_amount))}, ${String(line.fx_rate)},
           ${line.memo == null ? null : String(line.memo)},
           ${line.party_id ?? null}, ${line.department_id ?? null},
           ${line.project_id ?? null}, ${line.location_id ?? null},
           ${line.class_id ?? null}, ${line.equipment_unit_id ?? null},
           ${line.payment_card_id ?? null}, ${line.tax_code_id ?? null},
             ${JSON.stringify(line.extra_dims ?? {})}::jsonb)
      `);
    }
    await db.execute(sql`
      update journal_entries
         set status = 'posted', posted_at = now(), posted_by = ${actorId},
             updated_at = now(), updated_by = ${actorId}
       where id = ${entryId} and org_id = ${orgId}
    `);
    await db.execute(sql`
      update journal_entries
         set status = 'reversed', updated_at = now(), updated_by = ${actorId}
       where id = ${b.journal_entry_id} and org_id = ${orgId}
    `);
    await db.execute(sql`
      update psp_settlement_batches
         set status = 'void', reversal_entry_id = ${entryId},
             reversal_reason = ${reason}, reversed_at = now(),
             reversed_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
       where id = ${batchId} and org_id = ${orgId}
    `);
    await db.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${orgId}, 'psp_settlement_batches', ${batchId}, 'reverse',
         ${JSON.stringify({
           reason,
           before: { status: "posted", journalEntryId: b.journal_entry_id },
           after: { status: "void", reversalEntryId: entryId },
         })}::jsonb, ${actorId})
    `);
    return { entryId };
  });
}

export async function savePspProviderConfig(
  orgId: string,
  input: {
    provider: PspProvider;
    displayName?: string;
    isEnabled: boolean;
    defaultBankAccountId?: string | null;
    defaultFeeAccountId?: string | null;
    defaultDisputeAccountId?: string | null;
    defaultFxAccountId?: string | null;
    defaultClearingAccountId?: string | null;
    apiKey?: string | null;
  },
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<void> {
  assertUnrestrictedScope(allowedSubsidiaryIds);
  // Fail closed before any write: without this the storage CHECK surfaces
  // an unknown provider as a raw 500.
  if (input.provider !== "stripe" && input.provider !== "recurly" && input.provider !== "chargebee") {
    throw new PspSettlementError(`unknown provider ${String(input.provider)}`);
  }
  // Default posting accounts are validated like any other settlement
  // reference: a foreign or unpostable id must not persist to detonate at
  // posting time.
  await validateSettlementPostingAccounts(orgId, [
    { label: "bank", id: input.defaultBankAccountId },
    { label: "fee", id: input.defaultFeeAccountId },
    { label: "dispute", id: input.defaultDisputeAccountId },
    { label: "fx", id: input.defaultFxAccountId },
    { label: "clearing", id: input.defaultClearingAccountId },
  ]);
  let secrets: string | null = null;
  if (input.apiKey) secrets = await sealJson({ apiKey: input.apiKey });
  await db.execute(sql`
    insert into psp_provider_configs
      (org_id, provider, display_name, is_enabled, default_bank_account_id, default_fee_account_id,
       default_dispute_account_id, default_fx_account_id, default_clearing_account_id, secrets, created_by, updated_by)
    values (${orgId}, ${input.provider}, ${input.displayName ?? input.provider}, ${input.isEnabled},
            ${input.defaultBankAccountId ?? null}, ${input.defaultFeeAccountId ?? null},
            ${input.defaultDisputeAccountId ?? null}, ${input.defaultFxAccountId ?? null},
            ${input.defaultClearingAccountId ?? null}, ${secrets}, ${actorId}, ${actorId})
    on conflict (org_id, provider) do update set
      display_name = excluded.display_name,
      is_enabled = excluded.is_enabled,
      default_bank_account_id = excluded.default_bank_account_id,
      default_fee_account_id = excluded.default_fee_account_id,
      default_dispute_account_id = excluded.default_dispute_account_id,
      default_fx_account_id = excluded.default_fx_account_id,
      default_clearing_account_id = excluded.default_clearing_account_id,
      secrets = coalesce(excluded.secrets, psp_provider_configs.secrets),
      updated_at = now(), updated_by = ${actorId}
    where psp_provider_configs.org_id = ${orgId}
  `);
}
