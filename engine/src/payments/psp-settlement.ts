import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { assertPeriodModulesOpen } from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { cmp, fromUnits, isZero, mulRate, neg, toUnits } from "../money/money.ts";
import { sealJson } from "../platform/secrets.ts";
import { assertNotSandbox } from "../organization/sandbox-guard.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError, assertUnrestrictedScope, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { loadSubsidiaryContext, SubsidiaryError, uuidArray, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { fromMinorUnits, THREE_DECIMAL_CURRENCIES } from "./acceptance.ts";
import { isUuid } from "../platform/uuid.ts";

/**
 * PSP settlement import — Stripe / Recurly / Chargebee payout batches post
 * through the inventory-style kernel path (balanced journal_entries origin
 * `document` or allocation). Fees, disputes, refunds, adjustments, and FX legs
 * are evidence-backed settlement_lines. Idempotent on (org, provider, externalRef).
 */

export type PspProvider = "stripe" | "recurly" | "chargebee" | "shopify_payments" | "paypal";

/** Every provider the settlement importer accepts. Adding a provider is one entry here, one parser below, and the CHECK widening in the migration. */
export const PSP_PROVIDERS: readonly PspProvider[] = [
  "stripe",
  "recurly",
  "chargebee",
  "shopify_payments",
  "paypal",
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

/**
 * Every account a settlement batch can post to must resolve as a postable
 * account of the caller's org (active, non-summary). Tenant-coherent FKs
 * would kill a foreign account at the journal insert as a raw 500, and a
 * deactivated account only slightly later at the line guard — both long
 * after import/config accepted the reference. Fail closed here instead with
 * a domain error; a uniform refusal reveals nothing about other tenants.
 */
export async function validateSettlementPostingAccounts(
  orgId: string,
  accounts: { label: string; id: string | null | undefined }[],
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
  batchSubsidiaryId: string | null = null,
): Promise<void> {
  const ids = [
    ...new Set(
      accounts
        .map((a) => a.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  if (ids.length === 0) return;
  const malformed = ids.find((id) => !isUuid(id));
  if (malformed) {
    throw new PspSettlementError(
      `settlement account ${malformed} is not a valid account reference`,
    );
  }
  const rows = (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
    select id, subsidiary_id from accounts
     where org_id = ${orgId} and is_active and not is_summary
       and id = any(${`{${ids.join(",")}}`}::uuid[])
  `));
  const found = new Map(rows.rows.map((r) => [r.id.toLowerCase(), r.subsidiary_id]));
  const missing = ids.find((id) => !found.has(id.toLowerCase()));
  if (missing) {
    const label = accounts.find((a) => a.id === missing)?.label ?? "settlement";
    throw new PspSettlementError(
      `settlement ${label} account is not a postable account in this organization`,
    );
  }
  for (const id of ids) {
    const subsidiaryId = found.get(id.toLowerCase()) ?? null;
    if (
      !subsidiaryScopeAllows(allowedSubsidiaryIds, subsidiaryId, { orgWideNull: true }) ||
      (batchSubsidiaryId !== null && subsidiaryId !== null && subsidiaryId !== batchSubsidiaryId)
    ) {
      const label = accounts.find((a) => a.id === id)?.label ?? "settlement";
      throw new PspSettlementError(
        `settlement ${label} account is outside the authorized subsidiary scope`,
      );
    }
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
    /** Provider rate for this transaction into the payout currency (Stripe
     *  balance-transaction `exchange_rate`). Carried into the line meta as
     *  FX evidence; a foreign-currency row uses it at posting. */
    exchange_rate?: number | string | null;
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
    // as a TypeError with no schema help. Name the 1-based row
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
    // A supplied provider rate rides the line as FX evidence (validated, not
    // trusted blind: a malformed rate refuses naming the row). Rows without
    // one convert at the batch rate; a foreign-currency row with neither is
    // refused at import, naming exchange_rate.
    const lineMeta: Record<string, unknown> = { stripeType: rowType, fee: r.fee, net: r.net };
    if (r.exchange_rate != null) {
      lineMeta.exchangeRate = requireFxRate(
        r.exchange_rate,
        `Stripe transaction exchange_rate (${rowLabel})`,
      );
    }
    lines.push({
      kind,
      amount: major,
      externalRef: r.id,
      description: r.description ?? rowType,
      currency,
      meta: lineMeta,
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

/**
 * Exact decimal from a provider payload: Shopify Money and PayPal API amounts
 * arrive as decimal strings. Scientific notation, thousands separators and
 * over-precision are refused naming the field — silently coercing "1,234.56"
 * or 1e3 would book money nobody evidenced.
 */
function requireExactMoney(value: unknown, field: string): string {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
    throw new PspSettlementError(`${field} must be an exact decimal amount with at most 4 places`);
  }
  return fromUnits(toUnits(raw));
}

function requireProviderCurrency(code: unknown, provider: string, field: string): string {
  return requireSettlementCurrency(
    code,
    `${provider} ${field} is required`,
    `${provider} ${field} must be a three-letter currency code`,
  );
}

const SHOPIFY_BALANCE_KINDS: Record<string, SettlementLineKind | "payout"> = {
  charge: "charge",
  refund: "refund",
  dispute: "dispute",
  dispute_reversal: "dispute_reversal",
  reserve: "adjustment",
  adjustment: "adjustment",
  payout: "payout",
};

/**
 * Shopify Payments payout subset (Admin GraphQL `shopifyPaymentsAccount`
 * `payouts` / `balanceTransactions` shapes, per
 * https://shopify.dev/docs/api/admin-graphql/latest/objects/ShopifyPaymentsPayout
 * and
 * https://shopify.dev/docs/api/admin-graphql/latest/objects/ShopifyPaymentsBalanceTransaction):
 * the payout carries its id, currency and net, and every balance transaction
 * carries its type, amount, fee, net, currency and source order. Amounts are decimal strings in the
 * transaction currency, never floats. The payout's own movement rows are the
 * bank leg, not content, exactly like the Stripe payout movement.
 */
export function parseShopifyPaymentsPayout(
  payout: {
    id: string;
    currency?: string | null;
    amount?: string | number | null;
    net?: string | number | null;
    issuedAt?: string | null;
  },
  transactions: {
    id?: string | null;
    type: string;
    amount: string | number;
    fee?: string | number | null;
    net?: string | number | null;
    currency?: string | null;
    exchange_rate?: string | number | null;
    sourceOrderId?: string | null;
  }[],
  fallbackDate?: string,
): ParsedSettlement {
  const payoutId = (payout.id ?? "").trim();
  if (payoutId === "") throw new PspSettlementError("Shopify Payments payout id is required");
  const currency = requireProviderCurrency(payout.currency, "Shopify Payments", "payout currency");
  const settlementDate = (payout.issuedAt ?? fallbackDate ?? new Date().toISOString()).slice(0, 10);
  const lines: ParsedSettlementLine[] = [];
  let payoutAnchor: bigint | null = null;
  for (const [index, t] of transactions.entries()) {
    const rowType = (t.type ?? "").trim().toLowerCase().replace(/-/g, "_");
    const rowLabel = `row ${index + 1}${t.id ? ` ${t.id}` : ""}`;
    const mapped = SHOPIFY_BALANCE_KINDS[rowType];
    if (!mapped) {
      throw new PspSettlementError(
        `unsupported Shopify Payments balance type "${t.type}" (${rowLabel}): ` +
          `re-export the payout's balance transactions without it, or extend the importer to map it, before importing payout ${payoutId}`,
      );
    }
    const rowCurrency = requireProviderCurrency(
      t.currency ?? currency,
      "Shopify Payments",
      `transaction currency (${rowLabel})`,
    );
    if (rowCurrency !== currency) {
      throw new PspSettlementError(
        `mixed-currency Shopify Payments transactions (${currency}, ${rowCurrency}) cannot settle as one batch`,
      );
    }
    // The payout's own movement is a balance debit (negative): it anchors the
    // payout-total reconciliation, so it keeps its sign while content rows
    // stay magnitudes.
    if (mapped === "payout") {
      const signed = typeof t.amount === "number" ? String(t.amount) : t.amount.trim();
      if (!/^-?\d+(\.\d{1,4})?$/.test(signed)) {
        throw new PspSettlementError(
          `Shopify Payments transaction amount (${rowLabel}) must be an exact decimal amount with at most 4 places`,
        );
      }
      payoutAnchor = (payoutAnchor ?? 0n) - toUnits(fromUnits(toUnits(signed)));
      continue;
    }
    const amount = requireExactMoney(t.amount, `Shopify Payments transaction amount (${rowLabel})`);
    const meta: Record<string, unknown> = { shopifyType: rowType };
    if (t.sourceOrderId) meta.sourceOrderId = t.sourceOrderId;
    if (t.exchange_rate != null) {
      meta.exchangeRate = requireFxRate(t.exchange_rate, `Shopify Payments transaction exchange_rate (${rowLabel})`);
    }
    lines.push({
      kind: mapped,
      amount,
      externalRef: t.id ?? null,
      description: t.sourceOrderId ? `${rowType} for order ${t.sourceOrderId}` : rowType,
      currency,
      meta,
    });
    if (t.fee != null && String(t.fee).trim() !== "" && String(t.fee).trim() !== "0" && String(t.fee).trim() !== "0.00") {
      const fee = requireExactMoney(t.fee, `Shopify Payments transaction fee (${rowLabel})`);
      lines.push({
        kind: "fee",
        amount: fee,
        externalRef: t.id ? `${t.id}_fee` : null,
        description: "Shopify Payments transaction fee",
        currency,
        meta: { shopifyType: `${rowType}_fee` },
      });
    }
  }
  if (lines.length === 0) {
    throw new PspSettlementError(
      `settlement batch has no evidence lines: payout ${payoutId} carries only its own payout movement`,
    );
  }
  if (payoutAnchor !== null) {
    const computedNet = toUnits(summarizeSettlement(lines).netAmount);
    if (computedNet !== payoutAnchor) {
      throw new PspSettlementError(
        `Shopify Payments payout ${payoutId} does not reconcile: its payout movement totals ${fromUnits(payoutAnchor)} but settlement lines net to ${fromUnits(computedNet)}; ` +
          `re-export the payout's balance transactions without the payout movement row and import again`,
      );
    }
  }
  return {
    provider: "shopify_payments",
    externalRef: payoutId,
    settlementDate,
    currency,
    lines,
    memo: `Shopify Payments payout ${payoutId}`,
    raw: { payout, rowCount: transactions.length },
  };
}

/**
 * PayPal Transaction Search API (`/v1/reporting/transactions`) T-code
 * families. Only the long-stable families map; anything else refuses naming
 * the code, because a new PayPal event family booked as a charge would invent
 * receivables. Amounts are magnitudes — the family carries the direction.
 */
const PAYPAL_EVENT_FAMILIES: Record<string, SettlementLineKind> = {
  T00: "charge",
  T01: "transfer",
  T02: "transfer",
  T03: "transfer",
  T04: "charge",
  T05: "charge",
  T07: "charge",
  T08: "charge",
  T11: "refund",
  T12: "fee",
  T15: "adjustment",
  T20: "dispute",
  T21: "dispute",
};

function paypalKindFor(code: string, label: string): SettlementLineKind {
  const family = code.trim().toUpperCase().slice(0, 3);
  const kind = PAYPAL_EVENT_FAMILIES[family];
  if (!kind) {
    throw new PspSettlementError(
      `unsupported PayPal transaction event code "${code}" (${label}): ` +
        `map the event family in the PayPal importer before importing this batch`,
    );
  }
  return kind;
}

/**
 * PayPal Transaction Search API subset: `transaction_details` rows with
 * `transaction_info` (id, event code, dates, amounts, fee). One payout or
 * date-range export becomes one batch, idempotent on the export reference.
 */
export function parsePaypalTransactions(
  input: {
    reference: string;
    transactions: {
      transaction_info?: {
        transaction_id?: string;
        transaction_event_code?: string;
        transaction_initiated_date?: string;
        transaction_updated_date?: string;
        transaction_amount?: { currency_code?: string; value?: string | number };
        fee_amount?: { currency_code?: string; value?: string | number };
      };
    }[];
  },
  fallbackDate?: string,
): ParsedSettlement {
  const reference = (input.reference ?? "").trim();
  if (reference === "") throw new PspSettlementError("PayPal settlement reference is required");
  if (input.transactions.length === 0) {
    throw new PspSettlementError("settlement batch has no evidence lines");
  }
  const lines: ParsedSettlementLine[] = [];
  let currency = "";
  const today = new Date().toISOString().slice(0, 10);
  let settlementDate = fallbackDate ?? today;
  for (const [index, row] of input.transactions.entries()) {
    const info = row.transaction_info ?? {};
    const label = `row ${index + 1}${info.transaction_id ? ` ${info.transaction_id}` : ""}`;
    const code = info.transaction_event_code ?? "";
    if (code.trim() === "") {
      throw new PspSettlementError(`PayPal transaction event code is required (${label})`);
    }
    const kind = paypalKindFor(code, label);
    const amountValue = info.transaction_amount?.value;
    if (amountValue == null || String(amountValue).trim() === "") {
      throw new PspSettlementError(`PayPal transaction amount is required (${label})`);
    }
    const rowCurrency = requireProviderCurrency(
      info.transaction_amount?.currency_code,
      "PayPal",
      `transaction currency (${label})`,
    );
    if (currency === "") currency = rowCurrency;
    else if (rowCurrency !== currency) {
      throw new PspSettlementError(
        `mixed-currency PayPal transactions (${currency}, ${rowCurrency}) cannot settle as one batch`,
      );
    }
    // The export's first dated row sets the settlement day; an explicit
    // fallback date from the import form wins over provider dates.
    if (index === 0 && fallbackDate === undefined) {
      const initiated = info.transaction_initiated_date ?? info.transaction_updated_date;
      if (typeof initiated === "string" && /^\d{4}-\d{2}-\d{2}/.test(initiated)) {
        settlementDate = initiated.slice(0, 10);
      }
    }
    lines.push({
      kind,
      amount: requireExactMoney(amountValue, `PayPal transaction amount (${label})`),
      externalRef: info.transaction_id ?? null,
      description: `PayPal ${code.trim().toUpperCase()}`,
      currency,
      meta: { paypalEventCode: code.trim().toUpperCase() },
    });
    const feeValue = info.fee_amount?.value;
    if (feeValue != null && String(feeValue).trim() !== "" && String(feeValue).trim() !== "0" && String(feeValue).trim() !== "0.00") {
      lines.push({
        kind: "fee",
        amount: requireExactMoney(feeValue, `PayPal transaction fee (${label})`),
        externalRef: info.transaction_id ? `${info.transaction_id}_fee` : null,
        description: `PayPal fee (${code.trim().toUpperCase()})`,
        currency,
        meta: { paypalEventCode: `${code.trim().toUpperCase()}_fee` },
      });
    }
  }
  return {
    provider: "paypal",
    externalRef: reference,
    settlementDate,
    currency,
    lines,
    memo: `PayPal settlement ${reference}`,
    raw: { reference, rowCount: input.transactions.length },
  };
}

/**
 * PayPal settlement report CSV (STL): strict comma-separated values with a
 * header row. The classifier is the Transaction Event Code family (same map
 * as the API parser); Debit/Credit rides the line meta as evidence.
 */
export function parsePaypalSettlementCsv(csv: string, reference: string, fallbackDate?: string): ParsedSettlement {
  const ref = (reference ?? "").trim();
  if (ref === "") throw new PspSettlementError("PayPal settlement reference is required");
  const records = splitCsvRecords(csv);
  if (records.length < 2) {
    throw new PspSettlementError("PayPal settlement CSV carries no transaction rows");
  }
  const header = records[0]!.map((h) => h.trim().toLowerCase());
  const col = (name: string): number => header.indexOf(name);
  const codeCol = col("transaction event code");
  const idCol = col("transaction id");
  const amountCol = col("gross transaction amount");
  const currencyCol = col("gross transaction currency");
  const dcCol = ["transaction debit or credit", "debit or credit"].map(col).find((i) => i >= 0) ?? -1;
  const feeCol = ["fee amount", "fee"].map(col).find((i) => i >= 0) ?? -1;
  const dateCol = ["transaction completed date", "transaction initiated date"].map(col).find((i) => i >= 0) ?? -1;
  if (codeCol < 0 || idCol < 0 || amountCol < 0 || currencyCol < 0) {
    throw new PspSettlementError(
      "PayPal settlement CSV must carry Transaction ID, Transaction Event Code, Gross Transaction Amount and Gross Transaction Currency columns",
    );
  }
  const transactions = records.slice(1).map((fields) => ({
    transaction_info: {
      transaction_id: fields[idCol],
      transaction_event_code: fields[codeCol],
      transaction_initiated_date: dateCol >= 0 ? fields[dateCol] : undefined,
      transaction_amount: { currency_code: fields[currencyCol], value: fields[amountCol] },
      fee_amount: feeCol >= 0 ? { currency_code: fields[currencyCol], value: fields[feeCol] } : undefined,
    },
  }));
  const parsed = parsePaypalTransactions({ reference: ref, transactions }, fallbackDate);
  return {
    ...parsed,
    lines: parsed.lines.map((line, index) => {
      const dc = dcCol >= 0 ? (records[index + 1]?.[dcCol]?.trim() || null) : null;
      return dc ? { ...line, meta: { ...(line.meta ?? {}), paypalDebitOrCredit: dc } } : line;
    }),
  };
}

/** Minimal strict CSV reader: commas, double-quote escaping, CRLF rows. */
function splitCsvRecords(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  const text = csv.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n") {
      record.push(field);
      field = "";
      if (!(record.length === 1 && record[0]!.trim() === "")) records.push(record);
      record = [];
    } else if (ch === "\r") {
      continue;
    } else {
      field += ch;
    }
  }
  record.push(field);
  if (!(record.length === 1 && record[0]!.trim() === "")) records.push(record);
  if (quoted) throw new PspSettlementError("PayPal settlement CSV has an unterminated quoted field");
  return records;
}

/**
 * Parser registry: adding a provider is one entry here (plus the CHECK
 * widening). The settlements route dispatches through this instead of
 * branching per provider, so a new provider cannot strand the route.
 */
export const SETTLEMENT_PARSERS: Record<
  PspProvider,
  { label: string; kinds: string }
> = {
  stripe: { label: "Stripe", kinds: "balance transactions" },
  recurly: { label: "Recurly", kinds: "settlement payload" },
  chargebee: { label: "Chargebee", kinds: "settlement payload" },
  shopify_payments: { label: "Shopify Payments", kinds: "payout and balance transactions" },
  paypal: { label: "PayPal", kinds: "transaction search export or settlement CSV" },
};

export async function primaryBookId(orgId: string): Promise<string> {
  const r = (await db.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary and is_active and posts_gl
     limit 1 for share
  `));
  const id = r.rows[0]?.id;
  if (!id) throw new PspSettlementError("no active primary posting book");
  return id;
}

export async function periodForDate(
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameStoredImport(
  row: {
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
    source_currency: string | null;
    conversion_rate: string | null;
    conversion_rate_source: string | null;
    payout_rate: string | null;
    payout_rate_source: string | null;
    source_payload: unknown;
    line_count: number;
    memo: string | null;
  },
  lines: Array<{
    line_number: number;
    kind: string;
    external_ref: string | null;
    description: string | null;
    amount: string;
    currency: string | null;
    document_id: string | null;
    meta: unknown;
  }>,
  parsed: ParsedSettlement,
  accounts: Partial<ImportAccounts>,
  currency: string,
  totals: ReturnType<typeof summarizeSettlement>,
  subsidiaryId: string | null,
  fx: {
    sourceCurrency: string;
    conversionRate: string;
    conversionRateSource: string;
    payoutRate: string | null;
    payoutRateSource: string | null;
  } | null,
): boolean {
  const sameAmount = (stored: string, expected: string) => toUnits(stored) === toUnits(expected);
  if (
    row.currency !== currency
    || !sameAmount(row.gross_amount, totals.grossAmount)
    || !sameAmount(row.fee_amount, totals.feeAmount)
    || !sameAmount(row.refund_amount, totals.refundAmount)
    || !sameAmount(row.dispute_amount, totals.disputeAmount)
    || !sameAmount(row.adjustment_amount, totals.adjustmentAmount)
    || !sameAmount(row.net_amount, totals.netAmount)
    || !sameAmount(row.fx_amount, totals.fxAmount)
    || row.settlement_date !== parsed.settlementDate
    || row.bank_account_id !== (accounts.bankAccountId ?? null)
    || row.fee_account_id !== (accounts.feeAccountId ?? null)
    || row.dispute_account_id !== (accounts.disputeAccountId ?? null)
    || row.fx_account_id !== (accounts.fxAccountId ?? null)
    || row.clearing_account_id !== (accounts.clearingAccountId ?? null)
    || row.subsidiary_id !== subsidiaryId
    || (row.source_currency ?? null) !== (fx?.sourceCurrency ?? null)
    || (row.conversion_rate ?? null) !== (fx?.conversionRate ?? null)
    || (row.conversion_rate_source ?? null) !== (fx?.conversionRateSource ?? null)
    || (row.payout_rate ?? null) !== (fx?.payoutRate ?? null)
    || (row.payout_rate_source ?? null) !== (fx?.payoutRateSource ?? null)
    || stableJson(row.source_payload) !== stableJson(parsed.raw ?? null)
    || row.line_count !== parsed.lines.length
    || row.memo !== (parsed.memo ?? null)
    || lines.length !== parsed.lines.length
  ) return false;

  return parsed.lines.every((line, index) => {
    const stored = lines[index];
    // The document link is operator matching evidence, never provider
    // evidence: no parser sets documentId, so a stored link must not turn a
    // same-reference refetch into a conflict. Provider evidence (kind, ref,
    // description, amount, currency, meta) still refuses on any drift.
    return stored !== undefined
      && stored.line_number === index + 1
      && stored.kind === line.kind
      && stored.external_ref === (line.externalRef ?? null)
      && stored.description === (line.description ?? null)
      && sameAmount(stored.amount, line.amount)
      && stored.currency === (line.currency ?? null)
      && stableJson(stored.meta) === stableJson(line.meta ?? {});
  });
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
  // Cross-currency batches convert at evidenced rates only. Every line is in
  // the batch currency or the evidenced source currency, and every
  // source-currency line carries its own exchange_rate or rides the batch
  // conversion_rate. A foreign line with neither names exchange_rate, so an
  // operator knows exactly which evidence to supply.
  const fx = parsed.fx ?? null;
  let sourceCurrency = "";
  let conversionRate = "";
  let conversionRateSource = "";
  let payoutRate: string | null = null;
  let payoutRateSource: string | null = null;
  if (fx) {
    sourceCurrency = requireSettlementCurrency(
      fx.sourceCurrency,
      "settlement source currency is required whenever conversion evidence is supplied",
      "settlement source currency must be a three-letter currency code",
    );
    if (sourceCurrency === currency) {
      throw new PspSettlementError(
        "settlement source currency must differ from the batch currency",
      );
    }
    conversionRate = requireFxRate(fx.rate, "settlement conversion_rate");
    conversionRateSource = (fx.rateSource ?? "").trim();
    if (conversionRateSource === "") {
      throw new PspSettlementError(
        "settlement conversion_rate_source is required alongside conversion_rate",
      );
    }
    if (fx.payoutRate != null) {
      payoutRate = requireFxRate(fx.payoutRate, "settlement payout_rate");
      payoutRateSource = (fx.payoutRateSource ?? "").trim() || null;
      if (!payoutRateSource) {
        throw new PspSettlementError(
          "settlement payout_rate_source is required alongside payout_rate",
        );
      }
    }
  }
  for (const [lineIndex, line] of parsed.lines.entries()) {
    const lineCurrency = (line.currency ?? "").toUpperCase() || currency;
    if (lineCurrency !== currency && lineCurrency !== sourceCurrency) {
      throw new PspSettlementError(
        `settlement line ${lineIndex + 1} in ${lineCurrency} matches neither the batch currency ${currency} nor the evidenced source currency ${sourceCurrency || "(none)"}; re-import with conversion_rate evidence for that currency`,
      );
    }
    if (lineCurrency !== currency) {
      const meta = line.meta ?? {};
      if (meta.exchangeRate == null && conversionRate === "") {
        throw new PspSettlementError(
          `settlement line ${lineIndex + 1} in ${lineCurrency} has no exchange-rate evidence; supply exchange_rate on the balance transaction or conversion_rate on the batch import`,
        );
      }
      if (meta.exchangeRate != null) {
        requireFxRate(meta.exchangeRate, `settlement line ${lineIndex + 1} exchange_rate`);
      }
      if (meta.bookedAmount != null) {
        try {
          toUnits(String(meta.bookedAmount));
        } catch {
          throw new PspSettlementError(
            `settlement line ${lineIndex + 1} bookedAmount must be an exact decimal amount`,
          );
        }
      }
    }
    if (line.documentId != null && !isUuid(line.documentId)) {
      throw new PspSettlementError(
        `settlement line ${lineIndex + 1} receipt reference is not a valid document id`,
      );
    }
  }
  // The subsidiary reference enters the lifecycle here too: a malformed id
  // would otherwise die in Postgres as a raw uuid-cast 500, and a foreign
  // or inactive id would persist to strand the draft at posting.
  // Absence stays lenient — the import form asks up front, and posting
  // resolves an absent subsidiary exactly like every other document.
  const subsidiaryId =
    typeof accounts.subsidiaryId === "string" &&
    accounts.subsidiaryId !== ""
      ? accounts.subsidiaryId
      : null;
  if (subsidiaryId !== null) {
    if (!isUuid(subsidiaryId)) {
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
  // Resolve and authorize posting accounts before any write: direct API
  // callers must satisfy the same subsidiary boundary as the import picker.
  await validateSettlementPostingAccounts(
    orgId,
    [
      { label: "bank", id: accounts.bankAccountId },
      { label: "fee", id: accounts.feeAccountId },
      { label: "dispute", id: accounts.disputeAccountId },
      { label: "fx", id: accounts.fxAccountId },
      { label: "clearing", id: accounts.clearingAccountId },
    ],
    allowedSubsidiaryIds,
    subsidiaryId,
  );
  // Stored totals are always in payout (batch) currency: a cross-currency
  // batch converts each line at its evidenced rate before footing, so the
  // bank leg matches the payout the provider actually paid. Lines keep their
  // source amounts with the rate evidence; posting reconciles the two.
  const totals = fx
    ? summarizeSettlement(
      parsed.lines.map((line) => {
        const lineCurrency = (line.currency ?? "").toUpperCase() || currency;
        if (lineCurrency === currency) return line;
        const rate = requireFxRate(
          (line.meta ?? {}).exchangeRate ?? conversionRate,
          "settlement conversion_rate",
        );
        return { ...line, amount: mulRate(line.amount, rate), currency };
      }),
    )
    : summarizeSettlement(parsed.lines);
  return withOrg(orgId, async () => {
    const proposedId = randomUUID();
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into psp_settlement_batches (
        id, org_id, provider, external_ref, status, currency,
        gross_amount, fee_amount, refund_amount, dispute_amount, adjustment_amount, net_amount, fx_amount,
        settlement_date, bank_account_id, fee_account_id, dispute_account_id, fx_account_id,
        clearing_account_id, subsidiary_id, source_currency, conversion_rate, conversion_rate_source,
        payout_rate, payout_rate_source, source_payload, line_count, memo, created_by, updated_by
      ) values (
        ${proposedId}, ${orgId}, ${parsed.provider}, ${parsed.externalRef}, 'draft', ${currency},
        ${totals.grossAmount}, ${totals.feeAmount}, ${totals.refundAmount}, ${totals.disputeAmount},
        ${totals.adjustmentAmount}, ${totals.netAmount}, ${totals.fxAmount}, ${parsed.settlementDate},
        ${accounts.bankAccountId ?? null}, ${accounts.feeAccountId ?? null},
        ${accounts.disputeAccountId ?? null}, ${accounts.fxAccountId ?? null},
        ${accounts.clearingAccountId ?? null}, ${subsidiaryId},
        ${sourceCurrency || null}, ${conversionRate || null}, ${conversionRateSource || null},
        ${payoutRate}, ${payoutRateSource},
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
    if (row.status === "void") {
      throw new PspSettlementError(
        "a voided provider settlement reference cannot be reused",
      );
    }
    const batchId = row.id;
    if (!created) {
      const stored = (await db.execute<{
        status: string;
        provider: string;
        external_ref: string;
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
        source_currency: string | null;
        conversion_rate: string | null;
        conversion_rate_source: string | null;
        payout_rate: string | null;
        payout_rate_source: string | null;
        source_payload: unknown;
        line_count: number;
        memo: string | null;
      }>(sql`
        select status, provider, external_ref, currency, gross_amount::text, fee_amount::text,
               refund_amount::text, dispute_amount::text, adjustment_amount::text,
               net_amount::text, fx_amount::text, settlement_date::text,
               bank_account_id, fee_account_id, dispute_account_id, fx_account_id,
               clearing_account_id, subsidiary_id, source_currency, conversion_rate::text,
               conversion_rate_source, payout_rate::text, payout_rate_source,
               source_payload, line_count, memo
          from psp_settlement_batches
         where id = ${batchId} and org_id = ${orgId}
      `)).rows[0];
      const storedLines = (await db.execute<{
        line_number: number;
        kind: string;
        external_ref: string | null;
        description: string | null;
        amount: string;
        currency: string | null;
        document_id: string | null;
        meta: unknown;
      }>(sql`
        select line_number, kind, external_ref, description, amount::text, currency, document_id, meta
          from psp_settlement_lines
         where batch_id = ${batchId} and org_id = ${orgId}
         order by line_number
      `)).rows;
      if (!stored || !sameStoredImport(stored, storedLines, parsed, accounts, currency, totals, subsidiaryId, sourceCurrency ? {
        sourceCurrency,
        conversionRate,
        conversionRateSource,
        payoutRate,
        payoutRateSource,
      } : null)) {
        if (!stored) throw new PspSettlementError("settlement batch could not be read");
        throw new PspSettlementConflictError(
          "provider settlement reference already has different evidence; use the persisted batch, then reverse it or record a separate adjustment",
          {
            batchId,
            status: stored.status,
            provider: stored.provider,
            externalRef: stored.external_ref,
            currency: stored.currency,
            totals: {
              grossAmount: stored.gross_amount,
              feeAmount: stored.fee_amount,
              refundAmount: stored.refund_amount,
              disputeAmount: stored.dispute_amount,
              adjustmentAmount: stored.adjustment_amount,
              netAmount: stored.net_amount,
              fxAmount: stored.fx_amount,
            },
          },
        );
      }
      return { batchId, created: false };
    }
    await insertLines(orgId, batchId, parsed.lines, actorId);
    // Margin restatement for the channel orders named in this payout. The
    // commerce module owns the restatement queue and this module cannot
    // import it (commerce already depends on payments, so the edge would
    // cycle), hence the direct insert. A payout with no channel orders
    // matches zero rows by design, and a retried import collides on
    // (org, order) with the first mark winning — both benign.
    await db.execute(sql`
      insert into channel_order_economics_pending (org_id, order_id, reason)
      select ${orgId}, o.id, ${`payout ${parsed.externalRef} settled`}
        from channel_orders o
       where o.org_id = ${orgId}
         and o.external_id in (
           select distinct l.meta->>'sourceOrderId'
             from psp_settlement_lines l
            where l.org_id = ${orgId} and l.batch_id = ${batchId} and l.meta ? 'sourceOrderId')
      on conflict (org_id, order_id) do nothing`);
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
        (org_id, batch_id, line_number, kind, external_ref, description, amount, currency, document_id, meta, created_by, updated_by)
      values (${orgId}, ${batchId}, ${n}, ${l.kind}, ${l.externalRef ?? null}, ${l.description ?? null},
              ${l.amount}, ${l.currency ?? null}, ${l.documentId ?? null},
              ${JSON.stringify(l.meta ?? {})}::jsonb, ${actorId}, ${actorId})
    `);
  }
}

/**
 * Convert one FX batch into base-currency legs. Every foreign line converts
 * at its own exchange_rate (or the batch conversion_rate) into payout
 * currency, then at payout_rate into base — exact decimal math, no floats.
 * Legs with receipt booking (a linked posted receipt in the line currency,
 * or explicit bookedAmount evidence) post at the booked amount; the summed
 * converted-minus-booked difference returns as realized FX gain/loss.
 * Legs without booking post at converted and contribute nothing.
 */
async function buildFxLegs(
  orgId: string,
  batchId: string,
  b: {
    currency: string;
    net_amount: string;
    fee_amount: string;
  },
  fxPlan: { sourceCurrency: string; conversionRate: string; payoutRate: string },
): Promise<{
  bank: string;
  fee: string;
  refund: string;
  dispute: string;
  adjustment: string;
  realized: string;
}> {
  const rows = (await db.execute<{
    line_number: number;
    kind: string;
    amount: string;
    currency: string | null;
    document_id: string | null;
    meta: unknown;
  }>(sql`
    select line_number, kind, amount::text, currency, document_id, meta
      from psp_settlement_lines
     where batch_id = ${batchId} and org_id = ${orgId}
     order by line_number
  `)).rows;
  const bookedKinds = new Set(["charge", "refund", "dispute", "dispute_reversal", "adjustment", "transfer"]);
  let refund = 0n;
  let dispute = 0n;
  let adjustment = 0n;
  let realized = 0n;
  for (const row of rows) {
    const lineCurrency = (row.currency ?? b.currency).toUpperCase();
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    const rateIntoPayout = lineCurrency === b.currency
      ? "1"
      : requireFxRate(
        meta.exchangeRate ?? fxPlan.conversionRate,
        `settlement line ${row.line_number} exchange_rate`,
      );
    const convertedBase = toUnits(mulRate(mulRate(row.amount, rateIntoPayout), fxPlan.payoutRate));
    let bookedBase = convertedBase;
    if (bookedKinds.has(row.kind)) {
      if (meta.bookedAmount != null) {
        try {
          bookedBase = toUnits(fromUnits(toUnits(String(meta.bookedAmount))));
        } catch {
          throw new PspSettlementError(
            `settlement line ${row.line_number} bookedAmount must be an exact decimal amount`,
          );
        }
      } else if (row.document_id != null) {
        const receipt = (await db.execute<{
          status: string;
          currency: string;
          total: string;
          fx_rate: string;
        }>(sql`
          select status, currency, total::text, fx_rate::text
            from documents
           where id = ${row.document_id} and org_id = ${orgId}
        `)).rows[0];
        if (!receipt) {
          throw new PspSettlementError(
            `settlement line ${row.line_number} links receipt ${row.document_id}, which is not in this organization; relink the line and import again`,
          );
        }
        if (receipt.status !== "posted") {
          throw new PspSettlementError(
            `settlement line ${row.line_number} links receipt ${row.document_id}, which is ${receipt.status}; realized FX posts only against posted receipts`,
          );
        }
        if (receipt.currency.toUpperCase() !== lineCurrency) {
          throw new PspSettlementError(
            `settlement line ${row.line_number} in ${lineCurrency} links receipt ${row.document_id} in ${receipt.currency}; realized FX needs the receipt in the line currency`,
          );
        }
        if (toUnits(row.amount) !== toUnits(receipt.total)) {
          throw new PspSettlementError(
            `settlement line ${row.line_number} amount ${row.amount} does not match linked receipt ${row.document_id} total ${receipt.total}; link one line per receipt or supply bookedAmount evidence`,
          );
        }
        bookedBase = toUnits(mulRate(receipt.total, receipt.fx_rate));
      }
      realized += convertedBase - bookedBase;
    }
    if (row.kind === "refund") refund += bookedBase < 0n ? -bookedBase : bookedBase;
    else if (row.kind === "dispute") dispute += bookedBase < 0n ? -bookedBase : bookedBase;
    else if (row.kind === "dispute_reversal") dispute -= bookedBase < 0n ? -bookedBase : bookedBase;
    else if (row.kind === "adjustment") adjustment += bookedBase < 0n ? -bookedBase : bookedBase;
  }
  return {
    bank: mulRate(b.net_amount, fxPlan.payoutRate),
    fee: mulRate(b.fee_amount, fxPlan.payoutRate),
    refund: fromUnits(refund),
    dispute: fromUnits(dispute),
    adjustment: fromUnits(adjustment),
    realized: fromUnits(realized),
  };
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
        source_currency: string | null;
        conversion_rate: string | null;
        conversion_rate_source: string | null;
        payout_rate: string | null;
        payout_rate_source: string | null;
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
    // combined check blamed accounts the batch already carried.
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
    // Cross-currency batches post at evidenced rates: every foreign leg
    // converts through the batch conversion_rate (or its own exchange_rate)
    // into payout currency, then through payout_rate into base. A missing
    // rate stays a named refusal — converting at an assumed rate would book
    // money nobody evidenced.
    const baseCurrency = subsidiary.baseCurrency;
    const fxBatch = b.source_currency != null || b.currency !== baseCurrency;
    let fxPlan: {
      sourceCurrency: string;
      conversionRate: string;
      payoutRate: string;
    } | null = null;
    if (fxBatch) {
      const sourceCurrency = (b.source_currency ?? b.currency).toUpperCase();
      const conversionRate = b.source_currency != null
        ? requireFxRate(b.conversion_rate, "settlement conversion_rate")
        : "1";
      if (b.currency !== baseCurrency && b.payout_rate == null) {
        throw new PspSettlementError(
          `cross-currency PSP settlement ${b.currency}→${baseCurrency} requires payout_rate evidence; re-import the same provider reference with payout_rate to repair this draft`,
        );
      }
      if (b.source_currency != null && b.conversion_rate == null) {
        throw new PspSettlementError(
          `cross-currency PSP settlement carries source currency ${sourceCurrency} without conversion_rate evidence; re-import the same provider reference with conversion_rate to repair this draft`,
        );
      }
      const payoutRate = b.currency === baseCurrency
        ? "1"
        : requireFxRate(b.payout_rate, "settlement payout_rate");
      fxPlan = { sourceCurrency, conversionRate, payoutRate };
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

    // Build balanced lines in the subsidiary's functional currency. Legs paid
    // in a foreign payout currency carry that currency's amount and the
    // evidenced payout rate, so the ledger records the real foreign balance.
    type JL = { accountId: string; amount: string; memo: string; currency?: string; txnAmount?: string; fxRate?: string };
    const jlines: JL[] = [];

    // A cross-currency batch converts every leg to base at evidenced rates and
    // books the realized difference against the receipts' booked amounts to
    // the FX gain/loss account. Single-currency batches keep the stored
    // totals path below unchanged.
    let fxRealized: string | null = null;
    if (fxPlan) {
      const fxLegs = await buildFxLegs(orgId, batchId, b, fxPlan);
      fxRealized = fxLegs.realized;
      if (!isZero(fxRealized) && !fxAcct) {
        throw new PspSettlementError(
          "realized FX gain/loss account is not configured",
        );
      }
      const payoutDetail = (txnAmount: string) => b.currency === baseCurrency
        ? {}
        : { currency: b.currency, txnAmount, fxRate: fxPlan!.payoutRate };
      if (!isZero(fxLegs.bank)) {
        jlines.push({ accountId: b.bank_account_id!, amount: fxLegs.bank, memo: "PSP net deposit", ...payoutDetail(b.net_amount) });
      }
      if (!isZero(fxLegs.fee)) {
        jlines.push({ accountId: b.fee_account_id!, amount: fxLegs.fee, memo: "PSP processing fees", ...payoutDetail(b.fee_amount) });
      }
      if (!isZero(fxLegs.refund)) {
        jlines.push({ accountId: b.clearing_account_id!, amount: fxLegs.refund, memo: "PSP refunds" });
      }
      if (!isZero(fxLegs.dispute)) {
        jlines.push({ accountId: disputeAcct!, amount: fxLegs.dispute, memo: "PSP disputes" });
      }
      if (!isZero(fxLegs.adjustment)) {
        jlines.push({ accountId: b.clearing_account_id!, amount: fxLegs.adjustment, memo: "PSP adjustments" });
      }
      if (!isZero(fxRealized)) {
        jlines.push({
          accountId: fxAcct!,
          amount: neg(fxRealized), // realized gain (converted above booked) = credit
          memo: `PSP realized FX at ${fxPlan.sourceCurrency} evidence`,
        });
      }
      const fxRunning = jlines.reduce((s, l) => s + toUnits(l.amount), 0n);
      const fxClear = fromUnits(-fxRunning);
      if (!isZero(fxClear)) {
        jlines.push({
          accountId: b.clearing_account_id!,
          amount: fxClear,
          memo: "PSP clearing / charges",
        });
      }
      // The realized plug is posting evidence: stamp it onto the batch so the
      // stored row shows the booked FX, not just the import-time fx legs.
      const stamped = await db.execute(sql`
        update psp_settlement_batches set fx_amount = ${fxRealized}, updated_at = now(), updated_by = ${actorId}
         where id = ${batchId} and org_id = ${orgId}
      `);
      if ((stamped.rowCount ?? 0) !== 1) {
        throw new PspSettlementError("settlement batch could not be stamped with realized FX");
      }
    } else {
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

    // Every journal write routes through the ONE ledger API.
    const entryId = randomUUID();
    // The full provider reference is the entry number, never truncated:
    // distinct provider references stay distinct ledger identities, so two
    // long references sharing a prefix can no longer collide on the
    // (org_id, entry_number) integrity guard and block posting. Uniqueness
    // holds because imports dedupe on (org_id, provider, external_ref),
    // re-posting a posted batch returns its existing entry, and reversals
    // suffix -VOID. Both entry_number and memo are unbounded text, so the
    // complete external reference is retained in the ledger.
    const entryNumber = `PSP-${b.provider.toUpperCase()}-${b.external_ref}`;
    const postedEntry = await postEntry(db, {
      id: entryId,
      orgId,
      bookId,
      subsidiaryId,
      entryNumber,
      postingDate: b.settlement_date,
      periodId,
      memo: b.memo ?? `PSP ${b.provider} ${b.external_ref}`,
      origin: "document",
      actorId,
      // A cross-currency batch's legs are converted to the functional currency.
      currency: fxPlan ? baseCurrency : b.currency,
      lines: jlines.map((l) => ({
        accountId: l.accountId,
        amount: l.amount,
        memo: l.memo,
        ...(l.currency ? { currency: l.currency, txnAmount: l.txnAmount, fxRate: l.fxRate } : {}),
      })),
    });
    if (postedEntry.entryId !== entryId)
      throw new PspSettlementError("settlement journal was not posted");
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

    // The reversal mirrors the source lines exactly through the ONE ledger
    // API; the source entry is then marked reversed — never edited.
    const entryId = randomUUID();
    const postedReversal = await postEntry(db, {
      id: entryId,
      orgId,
      bookId: original.book_id,
      subsidiaryId: original.subsidiary_id,
      entryNumber: `${original.entry_number}-VOID`,
      postingDate: input.reversalDate,
      periodId,
      memo: `Reversal: ${reason}`,
      origin: original.origin,
      reversesEntryId: b.journal_entry_id,
      actorId,
      lines: lines.rows.map((line) => ({
        accountId: String(line.account_id),
        subsidiaryId: String(line.subsidiary_id),
        amount: neg(String(line.amount)),
        currency: String(line.currency),
        txnAmount: neg(String(line.txn_amount)),
        fxRate: String(line.fx_rate),
        memo: line.memo == null ? null : String(line.memo),
        partyId: line.party_id == null ? null : String(line.party_id),
        departmentId: line.department_id == null ? null : String(line.department_id),
        projectId: line.project_id == null ? null : String(line.project_id),
        locationId: line.location_id == null ? null : String(line.location_id),
        classId: line.class_id == null ? null : String(line.class_id),
        equipmentUnitId: line.equipment_unit_id == null ? null : String(line.equipment_unit_id),
        paymentCardId: line.payment_card_id == null ? null : String(line.payment_card_id),
        taxCodeId: line.tax_code_id == null ? null : String(line.tax_code_id),
        extraDims: (line.extra_dims ?? {}) as Record<string, string>,
        lineNumber: Number(line.line_number),
      })),
    });
    if (postedReversal.entryId !== entryId)
      throw new PspSettlementError("settlement reversal was not posted");
    await markEntryReversed(db, { orgId, entryId: b.journal_entry_id, actorId });
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
    defaultDisputedFundsAccountId?: string | null;
    defaultChargebackLossAccountId?: string | null;
    defaultDisputeFeeAccountId?: string | null;
    refundPolicy?: "automatic" | "review";
    pullEnabled?: boolean;
    apiKey?: string | null;
  },
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<void> {
  assertUnrestrictedScope(allowedSubsidiaryIds);
  // Fail closed before any write: without this the storage CHECK surfaces
  // an unknown provider as a raw 500. The registry is the single list, so a
  // new provider cannot strand this guard behind the migration.
  if (!isPspProvider(input.provider)) {
    throw new PspSettlementError(`unknown provider ${String(input.provider)}`);
  }
  if (input.refundPolicy !== undefined && input.refundPolicy !== "automatic" && input.refundPolicy !== "review") {
    throw new PspSettlementError(`unknown refund policy ${String(input.refundPolicy)}`);
  }
  // Default posting accounts are validated like any other settlement
  // reference: a foreign or unpostable id must not persist to detonate at
  // posting time.
  await validateSettlementPostingAccounts(orgId, [
    { label: "bank", id: input.defaultBankAccountId },
    { label: "fee", id: input.defaultFeeAccountId },
    { label: "dispute", id: input.defaultDisputeAccountId },
    { label: "disputed-funds", id: input.defaultDisputedFundsAccountId },
    { label: "chargeback-loss", id: input.defaultChargebackLossAccountId },
    { label: "dispute-fee", id: input.defaultDisputeFeeAccountId },
    { label: "fx", id: input.defaultFxAccountId },
    { label: "clearing", id: input.defaultClearingAccountId },
  ]);
  let secrets: string | null = null;
  if (input.apiKey) secrets = await sealJson({ apiKey: input.apiKey }, { orgId, purpose: "payment.provider.secrets" });
  await db.execute(sql`
    insert into psp_provider_configs
      (org_id, provider, display_name, is_enabled, default_bank_account_id, default_fee_account_id,
       default_dispute_account_id, default_fx_account_id, default_clearing_account_id,
       default_disputed_funds_account_id, default_chargeback_loss_account_id, default_dispute_fee_account_id,
       refund_policy, pull_enabled, secrets, created_by, updated_by)
    values (${orgId}, ${input.provider}, ${input.displayName ?? input.provider}, ${input.isEnabled},
            ${input.defaultBankAccountId ?? null}, ${input.defaultFeeAccountId ?? null},
            ${input.defaultDisputeAccountId ?? null}, ${input.defaultFxAccountId ?? null},
            ${input.defaultClearingAccountId ?? null},
            ${input.defaultDisputedFundsAccountId ?? null}, ${input.defaultChargebackLossAccountId ?? null},
            ${input.defaultDisputeFeeAccountId ?? null},
            coalesce(${input.refundPolicy ?? null}, 'automatic'), coalesce(${input.pullEnabled ?? null}, false),
            ${secrets}, ${actorId}, ${actorId})
    on conflict (org_id, provider) do update set
      display_name = excluded.display_name,
      is_enabled = excluded.is_enabled,
      default_bank_account_id = excluded.default_bank_account_id,
      default_fee_account_id = excluded.default_fee_account_id,
      default_dispute_account_id = excluded.default_dispute_account_id,
      default_fx_account_id = excluded.default_fx_account_id,
      default_clearing_account_id = excluded.default_clearing_account_id,
      -- Automation fields are owned by the provider setup screen: an import
      -- save that omits them (it renders only posting defaults) keeps the
      -- stored policy instead of silently resetting review to automatic.
      -- Insert defaults live in the values above; updates preserve them.
      default_disputed_funds_account_id = coalesce(${input.defaultDisputedFundsAccountId ?? null}::uuid, psp_provider_configs.default_disputed_funds_account_id),
      default_chargeback_loss_account_id = coalesce(${input.defaultChargebackLossAccountId ?? null}::uuid, psp_provider_configs.default_chargeback_loss_account_id),
      default_dispute_fee_account_id = coalesce(${input.defaultDisputeFeeAccountId ?? null}::uuid, psp_provider_configs.default_dispute_fee_account_id),
      refund_policy = coalesce(${input.refundPolicy ?? null}, psp_provider_configs.refund_policy),
      pull_enabled = coalesce(${input.pullEnabled ?? null}::boolean, psp_provider_configs.pull_enabled),
      secrets = coalesce(excluded.secrets, psp_provider_configs.secrets),
      updated_at = now(), updated_by = ${actorId}
    where psp_provider_configs.org_id = ${orgId}
  `);
}

/**
 * Payout-to-order reconciliation. A settlement line is matchable when its
 * kind can name a native document (a charge settles a receipt, a refund
 * reverses one, a dispute claims one); fees, adjustments, transfers and FX
 * legs are provider economics, never order evidence, so they stay out of the
 * unmatched queue by construction.
 */
export const MATCHABLE_SETTLEMENT_LINE_KINDS: ReadonlySet<SettlementLineKind> = new Set([
  "charge",
  "refund",
  "dispute",
  "dispute_reversal",
]);

export function isMatchableSettlementLineKind(kind: string): boolean {
  return (MATCHABLE_SETTLEMENT_LINE_KINDS as ReadonlySet<string>).has(kind);
}

/** Fail closed when the banking surface is off: hidden means refused. */
async function requireBankingFeature(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, "banking"))) {
    throw new PspSettlementError(
      "Payout reconciliation is disabled; enable Banking in Company Settings → Features before matching payout lines",
    );
  }
}

type SettlementLineLock = {
  id: string;
  kind: string;
  document_id: string | null;
  amount: string;
  currency: string | null;
};

function auditSettlementLine(
  orgId: string,
  lineId: string,
  action: string,
  changes: Record<string, unknown>,
  actorId: string | null,
): Promise<unknown> {
  return db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'psp_settlement_lines', ${lineId}, ${action},
            ${JSON.stringify(changes)}::jsonb, ${actorId})
  `);
}

/**
 * Link one settlement line to its native document. The link is matching
 * evidence, never posted history: the journal stays untouched, and a later
 * reimport of the same provider reference converges onto the stored link
 * instead of conflicting. The document must be a posted record of this
 * organization — linking an unposted or foreign record would pretend the
 * payout settled something the ledger never booked.
 */
export async function setSettlementLineDocument(
  orgId: string,
  batchId: string,
  lineId: string,
  documentId: string,
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ lineId: string; documentId: string }> {
  if (!isUuid(documentId)) {
    throw new PspSettlementError(
      "a settlement line links only to a native document; choose the posted receipt, refund or payment this line settles",
    );
  }
  return withOrg(orgId, async () => {
    await requireBankingFeature(orgId);
    const batch = (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
      select id, subsidiary_id from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId} for update
    `)).rows[0];
    if (!batch) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(allowedSubsidiaryIds, batch.subsidiary_id)) throw new ScopeNotFoundError();
    const line = (await db.execute<SettlementLineLock>(sql`
      select id, kind, document_id, amount::text, currency from psp_settlement_lines
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId} for update
    `)).rows[0];
    if (!line) {
      throw new PspSettlementError(
        `settlement line ${lineId} is not part of batch ${batchId} in this organization; reload the payout and link the line again`,
      );
    }
    const doc = (await db.execute<{ id: string; kind: string; status: string; document_number: string | null }>(sql`
      select id, kind, status, document_number from documents
       where id = ${documentId} and org_id = ${orgId}
    `)).rows[0];
    if (!doc) {
      throw new PspSettlementError(
        "the linked record does not belong to this organization; choose a posted sales document in this organization",
      );
    }
    if (doc.status !== "posted") {
      throw new PspSettlementError(
        `document ${doc.document_number ?? documentId} is ${doc.status}, not posted; post it first, then link the settlement line`,
      );
    }
    const before = line.document_id;
    if (before === documentId) return { lineId, documentId };
    const updated = await db.execute(sql`
      update psp_settlement_lines set document_id = ${documentId}, updated_at = now(), updated_by = ${actorId}
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId}
    `);
    if ((updated.rowCount ?? 0) !== 1) {
      throw new PspSettlementError(`settlement line ${lineId} could not be linked; reload the payout and try again`);
    }
    await auditSettlementLine(orgId, lineId, "link", { before: { documentId: before }, after: { documentId } }, actorId);
    return { lineId, documentId };
  });
}

/**
 * Clear a line's document link. Matching evidence comes off; the journal
 * stays exactly as posted.
 */
export async function clearSettlementLineDocument(
  orgId: string,
  batchId: string,
  lineId: string,
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ lineId: string }> {
  return withOrg(orgId, async () => {
    await requireBankingFeature(orgId);
    const batch = (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
      select id, subsidiary_id from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId} for update
    `)).rows[0];
    if (!batch) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(allowedSubsidiaryIds, batch.subsidiary_id)) throw new ScopeNotFoundError();
    const line = (await db.execute<SettlementLineLock>(sql`
      select id, kind, document_id, amount::text, currency from psp_settlement_lines
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId} for update
    `)).rows[0];
    if (!line) {
      throw new PspSettlementError(
        `settlement line ${lineId} is not part of batch ${batchId} in this organization; reload the payout and try again`,
      );
    }
    if (line.document_id === null) return { lineId };
    const updated = await db.execute(sql`
      update psp_settlement_lines set document_id = null, updated_at = now(), updated_by = ${actorId}
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId}
    `);
    if ((updated.rowCount ?? 0) !== 1) {
      throw new PspSettlementError(`settlement line ${lineId} could not be unlinked; reload the payout and try again`);
    }
    await auditSettlementLine(orgId, lineId, "unlink", { before: { documentId: line.document_id }, after: { documentId: null } }, actorId);
    return { lineId };
  });
}

/**
 * Reclassify an unmatched line as a provider adjustment. Draft batches only:
 * the kind feeds the stored batch totals, and posted totals are history.
 * Totals are recomputed from the stored lines through the same summarizer
 * posting uses, so the batch still foots after the move.
 */
export async function markSettlementLineAdjustment(
  orgId: string,
  batchId: string,
  lineId: string,
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ lineId: string; kind: SettlementLineKind }> {
  return withOrg(orgId, async () => {
    await requireBankingFeature(orgId);
    const batch = (await db.execute<{ id: string; status: string; subsidiary_id: string | null }>(sql`
      select id, status, subsidiary_id from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId} for update
    `)).rows[0];
    if (!batch) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(allowedSubsidiaryIds, batch.subsidiary_id)) throw new ScopeNotFoundError();
    if (batch.status !== "draft") {
      throw new PspSettlementError(
        `batch is ${batch.status}; a posted payout's line kinds are history — reverse the batch and re-import it to reclassify`,
      );
    }
    const line = (await db.execute<SettlementLineLock>(sql`
      select id, kind, document_id, amount::text, currency from psp_settlement_lines
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId} for update
    `)).rows[0];
    if (!line) {
      throw new PspSettlementError(
        `settlement line ${lineId} is not part of batch ${batchId} in this organization; reload the payout and try again`,
      );
    }
    if (line.kind === "adjustment") return { lineId, kind: "adjustment" };
    if (line.document_id !== null) {
      throw new PspSettlementError(
        `settlement line ${lineId} is linked to document ${line.document_id}; unlink it before reclassifying as an adjustment`,
      );
    }
    if (line.kind === "fee" || line.kind === "fx_adjustment") {
      throw new PspSettlementError(
        `a ${line.kind} line is provider cost evidence, never an adjustment; link it to nothing and leave its kind alone`,
      );
    }
    const moved = await db.execute(sql`
      update psp_settlement_lines set kind = 'adjustment', updated_at = now(), updated_by = ${actorId}
       where id = ${lineId} and org_id = ${orgId} and batch_id = ${batchId}
    `);
    if ((moved.rowCount ?? 0) !== 1) {
      throw new PspSettlementError(`settlement line ${lineId} could not be reclassified; reload the payout and try again`);
    }
    const stored = (await db.execute<{ kind: string; amount: string; currency: string | null }>(sql`
      select kind, amount::text, currency from psp_settlement_lines
       where batch_id = ${batchId} and org_id = ${orgId}
    `)).rows;
    const totals = summarizeSettlement(
      stored.map((row) => ({ kind: row.kind as SettlementLineKind, amount: row.amount, currency: row.currency })),
    );
    const restamped = await db.execute(sql`
      update psp_settlement_batches
         set gross_amount = ${totals.grossAmount}, fee_amount = ${totals.feeAmount},
             refund_amount = ${totals.refundAmount}, dispute_amount = ${totals.disputeAmount},
             adjustment_amount = ${totals.adjustmentAmount}, net_amount = ${totals.netAmount},
             updated_at = now(), updated_by = ${actorId}
       where id = ${batchId} and org_id = ${orgId}
    `);
    if ((restamped.rowCount ?? 0) !== 1) {
      throw new PspSettlementError(`settlement batch ${batchId} could not be refooted after reclassification`);
    }
    await auditSettlementLine(
      orgId, lineId, "reclassify",
      { before: { kind: line.kind }, after: { kind: "adjustment", netAmount: totals.netAmount } },
      actorId,
    );
    return { lineId, kind: "adjustment" };
  });
}

export type DepositTieoutLine = {
  statementLineId: string;
  statementId: string;
  postedOn: string;
  amount: string;
  currency: string;
  description: string | null;
  bankTransactionId: string | null;
};

export type DepositTieout =
  | { status: "not_posted"; batchId: string }
  | {
    status: "tied" | "untied";
    batchId: string;
    provider: string;
    externalRef: string;
    netAmount: string;
    currency: string;
    settlementDate: string;
    depositLines: DepositTieoutLine[];
    /** Net minus tied deposit total; null when currencies differ. */
    gapAmount: string | null;
  };

/**
 * Tie a posted payout to its bank deposit through the existing bank
 * reconciliation matches: the batch's bank-leg journal lines matched to
 * statement lines ARE the deposit. No parallel link table — the tie-out is
 * derived, so unmatching in Banking moves the payout back to in-transit
 * with no sync step. Draft batches have no journal legs yet and report
 * not_posted.
 */
export async function batchDepositTieout(
  orgId: string,
  batchId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<DepositTieout> {
  return withOrg(orgId, async () => {
    const batch = (await db.execute<{
      id: string;
      provider: string;
      external_ref: string;
      status: string;
      currency: string;
      net_amount: string;
      settlement_date: string;
      bank_account_id: string | null;
      journal_entry_id: string | null;
      subsidiary_id: string | null;
    }>(sql`
      select id, provider, external_ref, status, currency, net_amount::text,
             settlement_date::text, bank_account_id, journal_entry_id, subsidiary_id
        from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId}
    `)).rows[0];
    if (!batch) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(allowedSubsidiaryIds, batch.subsidiary_id)) throw new ScopeNotFoundError();
    if (batch.status !== "posted" || !batch.journal_entry_id || !batch.bank_account_id) {
      return { status: "not_posted", batchId };
    }
    // Ledger sums name their book state: only live legs tie to a deposit.
    const legs = (await db.execute<{ id: string }>(sql`
      select jl.id from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${orgId} and jl.entry_id = ${batch.journal_entry_id}
         and jl.account_id = ${batch.bank_account_id}
         and je.status in ('posted', 'reversed')
    `)).rows;
    if (legs.length === 0) return {
      status: "untied",
      batchId,
      provider: batch.provider,
      externalRef: batch.external_ref,
      netAmount: batch.net_amount,
      currency: batch.currency,
      settlementDate: batch.settlement_date,
      depositLines: [],
      gapAmount: batch.net_amount,
    };
    const legIds = legs.map((leg) => leg.id);
    const deposits = (await db.execute<{
      statement_line_id: string;
      statement_id: string;
      posted_on: string;
      amount: string;
      currency: string;
      description: string | null;
      bank_transaction_id: string | null;
    }>(sql`
      select sl.id as statement_line_id, sl.statement_id, sl.posted_on::text,
             sl.amount::text, sl.currency, sl.description, sl.bank_transaction_id
        from reconciliation_matches m
        join bank_statement_lines sl on sl.id = m.statement_line_id and sl.org_id = m.org_id
       where m.org_id = ${orgId}
         and m.journal_line_id in (${sql.join(legIds.map((legId) => sql`${legId}::uuid`), sql`, `)})
       order by sl.posted_on, sl.id
    `)).rows;
    if (deposits.length === 0) {
      return {
        status: "untied",
        batchId,
        provider: batch.provider,
        externalRef: batch.external_ref,
        netAmount: batch.net_amount,
        currency: batch.currency,
        settlementDate: batch.settlement_date,
        depositLines: [],
        gapAmount: batch.net_amount,
      };
    }
    const foreign = deposits.find((row) => row.currency.toUpperCase() !== batch.currency.toUpperCase());
    let gapAmount: string | null = null;
    if (!foreign) {
      let tied = 0n;
      for (const row of deposits) tied += toUnits(row.amount);
      gapAmount = fromUnits(toUnits(batch.net_amount) - tied);
    }
    return {
      status: "tied",
      batchId,
      provider: batch.provider,
      externalRef: batch.external_ref,
      netAmount: batch.net_amount,
      currency: batch.currency,
      settlementDate: batch.settlement_date,
      depositLines: deposits.map((row) => ({
        statementLineId: row.statement_line_id,
        statementId: row.statement_id,
        postedOn: row.posted_on,
        amount: row.amount,
        currency: row.currency,
        description: row.description,
        bankTransactionId: row.bank_transaction_id,
      })),
      gapAmount,
    };
  });
}
