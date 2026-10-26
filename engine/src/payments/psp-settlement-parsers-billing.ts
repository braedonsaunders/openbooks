import { cmp, fromUnits, toUnits } from "../money/money.ts";
import { fromMinorUnits } from "./minor-units.ts";
import {
  PspSettlementError,
  fromChargebeeMinorUnits,
  fromPspMinorUnits,
  requireChargebeeCurrency,
  requireFxRate,
  requireRecurlyCurrency,
  summarizeSettlement,
} from "./psp-settlement-core.ts";
import type {
  ParsedSettlement,
  ParsedSettlementLine,
  SettlementLineKind,
} from "./psp-settlement-core.ts";

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
    const fee = r.fee == null ? null : fromPspMinorUnits(r.fee, "Stripe fee", true, currency);
    if (r.net != null) {
      fromPspMinorUnits(r.net, "Stripe net amount", false, currency);
    }
    // A missing type is a client-shape refusal, not a 500: the kind mapping
    // below reads `.includes` off this field, so an unvalidated row escapes
    // as a TypeError with no schema help. Name the 1-based row
    // (plus the provider id when the row carries one) so the payload can be
    // repaired field-by-field.
    const rowType = typeof r.type === "string" ? r.type : "";
    const rowIdSuffix = typeof r.id === "string" && r.id !== "" ? ` ${r.id}` : "";
    const rowLabel = `row ${index + 1}${rowIdSuffix}`;
    if (rowType === "") {
      throw new PspSettlementError(`Stripe transaction type is required (${rowLabel})`);
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
        amount: reversal ? fromPspMinorUnits(rawFee, "Stripe fee", false, currency) : fee,
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
export function parseRecurlySettlement(
  payload: {
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
  },
  fallbackDate?: string,
): ParsedSettlement {
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
export function parseChargebeeSettlement(
  payload: {
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
  },
  fallbackDate?: string,
): ParsedSettlement {
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
      : fromChargebeeMinorUnits(
          payload.amount_adjusted,
          "Chargebee amount adjusted",
          true,
          currency,
        );
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
        diff > 0n ? ` (${fromUnits(diff)} still due)` : ` (${fromUnits(-diff)} over-applied)`;
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
