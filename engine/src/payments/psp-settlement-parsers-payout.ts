import { fromUnits, toUnits } from "../money/money.ts";
import { fromMinorUnits } from "./minor-units.ts";
import {
  PspSettlementError,
  requireFxRate,
  requireSettlementCurrency,
  summarizeSettlement,
} from "./psp-settlement-core.ts";
import type {
  ParsedSettlement,
  ParsedSettlementLine,
  SettlementLineKind,
} from "./psp-settlement-core.ts";

/**
 * Exact decimal from a provider payload: Shopify Money and PayPal API amounts
 * arrive as decimal strings. Scientific notation, thousands separators and
 * over-precision are refused naming the field — silently coercing "1,234.56"
 * or 1e3 would book money nobody evidenced.
 */
function requireExactMoney(value: unknown, field: string): string {
  const raw =
    typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
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
      meta.exchangeRate = requireFxRate(
        t.exchange_rate,
        `Shopify Payments transaction exchange_rate (${rowLabel})`,
      );
    }
    lines.push({
      kind: mapped,
      amount,
      externalRef: t.id ?? null,
      description: t.sourceOrderId ? `${rowType} for order ${t.sourceOrderId}` : rowType,
      currency,
      meta,
    });
    if (
      t.fee != null &&
      String(t.fee).trim() !== "" &&
      String(t.fee).trim() !== "0" &&
      String(t.fee).trim() !== "0.00"
    ) {
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
    if (
      feeValue != null &&
      String(feeValue).trim() !== "" &&
      String(feeValue).trim() !== "0" &&
      String(feeValue).trim() !== "0.00"
    ) {
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
export function parsePaypalSettlementCsv(
  csv: string,
  reference: string,
  fallbackDate?: string,
): ParsedSettlement {
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
  const dcCol =
    ["transaction debit or credit", "debit or credit"].map(col).find((i) => i >= 0) ?? -1;
  const feeCol = ["fee amount", "fee"].map(col).find((i) => i >= 0) ?? -1;
  const dateCol =
    ["transaction completed date", "transaction initiated date"].map(col).find((i) => i >= 0) ?? -1;
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
      fee_amount:
        feeCol >= 0 ? { currency_code: fields[currencyCol], value: fields[feeCol] } : undefined,
    },
  }));
  const parsed = parsePaypalTransactions({ reference: ref, transactions }, fallbackDate);
  return {
    ...parsed,
    lines: parsed.lines.map((line, index) => {
      const dc = dcCol >= 0 ? records[index + 1]?.[dcCol]?.trim() || null : null;
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
  if (quoted)
    throw new PspSettlementError("PayPal settlement CSV has an unterminated quoted field");
  return records;
}

/** Square money: integer minor units of the currency, as the Payouts API reports them. */
export interface SquareMoney {
  amount: number | string;
  currency?: string | null;
}

/** Square Payout subset. `arrival_date` is the bank deposit day. */
export interface SquarePayoutInput {
  id: string;
  status?: string | null;
  arrival_date?: string | null;
  created_at?: string | null;
  amount_money: SquareMoney;
}

/**
 * Square PayoutEntry subset. Net is gross plus the fee, and a fee is reported
 * as a negative amount, so a charge nets to its gross less its fee.
 */
export interface SquarePayoutEntryInput {
  id?: string | null;
  payout_id?: string | null;
  effective_at?: string | null;
  type: string;
  gross_amount_money: SquareMoney;
  fee_amount_money?: SquareMoney | null;
  net_amount_money: SquareMoney;
  type_charge_details?: { payment_id?: string | null } | null;
  type_refund_details?: { payment_id?: string | null } | null;
  type_dispute_details?: { dispute_id?: string | null } | null;
}

/**
 * How one Square entry type books. The gross leg takes the shape named here
 * and the fee leg is separate; fee-only types book their whole net as fee.
 * A type outside this map refuses by name, because a new Square entry type
 * booked as a charge would invent receivables.
 */
type SquareEntryShape =
  "charge" | "refund" | "fee_only" | "adjustment" | "dispute" | "dispute_reversal";

const SQUARE_ENTRY_SHAPES: ReadonlyMap<string, SquareEntryShape> = new Map([
  ["CHARGE", "charge"],
  ["REFUND", "refund"],
  ["FEE", "fee_only"],
  ["DEPOSIT_FEE", "fee_only"],
  ["PAID_SERVICE_FEE", "fee_only"],
  ["ADJUSTMENT", "adjustment"],
  ["HOLD_ADJUSTMENT", "adjustment"],
  ["RELEASE_ADJUSTMENT", "adjustment"],
  ["OPEN_DISPUTE", "dispute"],
  ["CLOSE_DISPUTE", "dispute_reversal"],
]);

function nonEmptyId(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Square money to exact minor units. Only integers are accepted: a JSON
 * number outside the safe range or a decimal string refuses by name rather
 * than being rounded into a booking.
 */
function squareMinorUnits(
  money: SquareMoney | null | undefined,
  field: string,
  currency: string,
): bigint {
  if (!money) throw new PspSettlementError(`${field} is required`);
  const code = requireProviderCurrency(money.currency, "Square", `${field} currency`);
  if (code !== currency) {
    throw new PspSettlementError(
      `mixed-currency Square transactions (${currency}, ${code}) cannot settle as one batch`,
    );
  }
  const raw =
    typeof money.amount === "number"
      ? Number.isSafeInteger(money.amount)
        ? String(money.amount)
        : ""
      : typeof money.amount === "string"
        ? money.amount.trim()
        : "";
  if (!/^-?\d+$/.test(raw)) {
    throw new PspSettlementError(`${field} must be an integer amount in Square minor units`);
  }
  return BigInt(raw);
}

/**
 * Square payout (Payouts API: Payout with its PayoutEntry objects). One payout
 * is one settlement batch, idempotent on its id. Each entry must foot
 * (net = gross + fee), and the entries must total the payout amount, so a
 * partial entry page refuses instead of posting a short deposit. The payout
 * movement is the bank leg and is not booked as content. Failed and canceled
 * payouts never reached the bank, so they refuse.
 */
export function parseSquarePayout(
  payout: SquarePayoutInput,
  entries: SquarePayoutEntryInput[],
  fallbackDate?: string,
): ParsedSettlement {
  const payoutId = (payout.id ?? "").trim();
  if (payoutId === "") throw new PspSettlementError("Square payout id is required");
  const status = (payout.status ?? "").trim().toUpperCase();
  if (status === "FAILED" || status === "CANCELED") {
    throw new PspSettlementError(
      `Square payout ${payoutId} is ${status} and did not settle to the bank account; import the payout that settled instead`,
    );
  }
  const currency = requireProviderCurrency(
    payout.amount_money?.currency,
    "Square",
    "payout currency",
  );
  const payoutTotal = squareMinorUnits(payout.amount_money, "Square payout amount", currency);
  const settlementDate = (payout.arrival_date ?? fallbackDate ?? new Date().toISOString()).slice(
    0,
    10,
  );
  if (entries.length === 0) {
    throw new PspSettlementError(
      `settlement batch has no evidence lines: Square payout ${payoutId} carries no entries`,
    );
  }
  const lines: ParsedSettlementLine[] = [];
  let entryNetTotal = 0n;
  for (const [index, entry] of entries.entries()) {
    const entryId = (entry.id ?? "").trim();
    const label = `entry ${index + 1}${entryId ? ` ${entryId}` : ""}`;
    if (entryId === "")
      throw new PspSettlementError(`Square payout entry id is required (${label})`);
    const entryPayoutId = (entry.payout_id ?? "").trim();
    if (entryPayoutId !== "" && entryPayoutId !== payoutId) {
      throw new PspSettlementError(
        `Square entry ${entryId} belongs to payout ${entryPayoutId}, not ${payoutId}; import only this payout's entries`,
      );
    }
    const type = (entry.type ?? "").trim().toUpperCase();
    const shape = SQUARE_ENTRY_SHAPES.get(type);
    if (!shape) {
      throw new PspSettlementError(
        `unsupported Square payout entry type "${entry.type}" (${label}): ` +
          `re-export the payout's entries without it, or extend the importer to map it, before importing payout ${payoutId}`,
      );
    }
    const gross = squareMinorUnits(
      entry.gross_amount_money,
      `Square entry gross amount (${label})`,
      currency,
    );
    const fee =
      entry.fee_amount_money == null
        ? 0n
        : squareMinorUnits(entry.fee_amount_money, `Square entry fee amount (${label})`, currency);
    const net = squareMinorUnits(
      entry.net_amount_money,
      `Square entry net amount (${label})`,
      currency,
    );
    if (gross + fee !== net) {
      throw new PspSettlementError(
        `Square entry ${entryId} does not foot: gross ${fromMinorUnits(gross, currency)} plus fee ${fromMinorUnits(fee, currency)} is not net ${fromMinorUnits(net, currency)}; ` +
          `fees are negative amounts in Square's entry, so confirm this entry came from payout ${payoutId} and import it again`,
      );
    }
    entryNetTotal += net;

    const meta: Record<string, unknown> = { squareType: type };
    const paymentId =
      nonEmptyId(entry.type_charge_details?.payment_id) ??
      nonEmptyId(entry.type_refund_details?.payment_id);
    if (paymentId) meta.squarePaymentId = paymentId;
    const disputeId = nonEmptyId(entry.type_dispute_details?.dispute_id);
    if (disputeId) meta.squareDisputeId = disputeId;
    const description = `Square ${type.toLowerCase()}`;
    const refuseSign = (why: string) =>
      new PspSettlementError(
        `Square ${type} entry ${label} ${why}; re-export the payout's entries and import payout ${payoutId} again`,
      );
    const entryLines: ParsedSettlementLine[] = [];

    if (shape === "fee_only") {
      entryLines.push({
        kind: "fee",
        amount: fromMinorUnits(-net, currency),
        externalRef: entryId,
        description,
        currency,
        meta: { ...meta },
      });
    } else {
      let primary: { kind: SettlementLineKind; units: bigint } | null = null;
      switch (shape) {
        case "charge":
          if (gross < 0n) throw refuseSign("has a negative gross amount");
          primary = { kind: "charge", units: gross };
          break;
        case "refund":
          if (gross > 0n) throw refuseSign("has a positive gross amount");
          primary = { kind: "refund", units: -gross };
          break;
        case "adjustment":
          // A debit reduces the net as an adjustment. A credit rides the
          // signed miscellaneous bucket, because the adjustment kind always
          // reduces the net.
          primary =
            gross < 0n
              ? { kind: "adjustment", units: -gross }
              : gross > 0n
                ? { kind: "other", units: gross }
                : null;
          break;
        case "dispute":
          if (gross > 0n) throw refuseSign("has a positive gross amount");
          primary = { kind: "dispute", units: -gross };
          break;
        case "dispute_reversal":
          if (gross < 0n) throw refuseSign("has a negative gross amount");
          primary = { kind: "dispute_reversal", units: gross };
          break;
      }
      if (primary && primary.units !== 0n) {
        entryLines.push({
          kind: primary.kind,
          amount: fromMinorUnits(primary.units, currency),
          externalRef: entryId,
          description,
          currency,
          meta: { ...meta },
        });
      }
      if (fee !== 0n) {
        // The fee is a cost when negative in Square's entry, so the leg is
        // the negated fee; a returned fee on a refund books as a credit.
        entryLines.push({
          kind: "fee",
          amount: fromMinorUnits(-fee, currency),
          externalRef: `${entryId}_fee`,
          description: `${description} fee`,
          currency,
          meta: { ...meta },
        });
      }
    }
    // Tripwire: the lines this entry books must reproduce its Square net
    // exactly, under the same arithmetic the batch totals use.
    const netMajor = fromMinorUnits(net, currency);
    if (toUnits(summarizeSettlement(entryLines).netAmount) !== toUnits(netMajor)) {
      throw new PspSettlementError(
        `Square entry ${entryId} does not book to its net ${netMajor}; the importer refuses rather than post a different amount`,
      );
    }
    lines.push(...entryLines);
  }
  if (lines.length === 0) {
    throw new PspSettlementError(
      `settlement batch has no evidence lines: Square payout ${payoutId} carries only zero-amount entries`,
    );
  }
  if (entryNetTotal !== payoutTotal) {
    throw new PspSettlementError(
      `Square payout ${payoutId} does not reconcile: its amount is ${fromMinorUnits(payoutTotal, currency)} but its entries net to ${fromMinorUnits(entryNetTotal, currency)}; ` +
        `fetch every page of the payout's entries and import payout ${payoutId} again`,
    );
  }
  return {
    provider: "square",
    externalRef: payoutId,
    settlementDate,
    currency,
    lines,
    memo: `Square payout ${payoutId}`,
    raw: { payout: { id: payoutId, status: status || null }, entryCount: entries.length },
  };
}
