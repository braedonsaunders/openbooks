import { fromUnits, mulDecimal, toUnits } from "../money/money.ts";
import type { NativeContext, NativeDocLine, NativeDocument } from "./native.ts";

/**
 * Xero → native openbooks documents:
 *
 *   Invoice ACCREC      → customer_invoice    Invoice ACCPAY      → vendor_bill
 *   CreditNote ACCRECCREDIT → customer_credit ACCPAYCREDIT        → vendor_credit
 *   Payment (by settled target: Invoice/CreditNote/Prepayment/Overpayment
 *   type, PaymentType family fallback) → customer/vendor_payment
 *   ManualJournal       → journal             BankTransfer        → transfer
 *   BankTransaction SPEND → check             BankTransaction RECEIVE → deposit
 *
 * Line items carry AccountCode (not id) — the adapter provides a code→id map.
 * Tax rides per-line TaxAmount at Xero's ACTUAL amounts, keyed by TaxType →
 * ref-keyed tax code. Amounts convert to base via CurrencyRate when present.
 * VOIDED / DELETED sources signal "cancelled" (report-only divergence flag).
 */

export interface XeroLineItem {
  Description?: string;
  AccountCode?: string;
  ItemCode?: string;
  TaxType?: string;
  TaxAmount?: number;
  LineAmount?: number;
}

export interface XeroPaymentTarget {
  InvoiceID?: string;
  CreditNoteID?: string;
  PrepaymentID?: string;
  OverpaymentID?: string;
  Type?: string;
}

export interface XeroDoc {
  InvoiceID?: string;
  CreditNoteID?: string;
  PaymentID?: string;
  ManualJournalID?: string;
  BankTransactionID?: string;
  BankTransferID?: string;
  Type?: string;
  /** Payment-side fields (Xero `Payment` schema): the settled target rides
   * one of Invoice / CreditNote / Prepayment / Overpayment, and PaymentType
   * names the payment family. */
  PaymentType?: string;
  CreditNote?: XeroPaymentTarget;
  Prepayment?: XeroPaymentTarget;
  Overpayment?: XeroPaymentTarget;
  Status?: string;
  Contact?: { ContactID?: string };
  DateString?: string;
  Date?: string;
  DueDateString?: string;
  InvoiceNumber?: string;
  CreditNoteNumber?: string;
  /** Bank-transaction reconciliation state (SPEND/RECEIVE carry it per header). */
  IsReconciled?: boolean;
  Reference?: string;
  Narration?: string;
  LineItems?: XeroLineItem[];
  JournalLines?: { LineAmount?: number; AccountCode?: string; Description?: string }[];
  CurrencyRate?: number;
  CurrencyCode?: string;
  Total?: number;
  TotalTax?: number;
  Amount?: number;
  Invoice?: XeroPaymentTarget;
  Account?: { AccountID?: string; Code?: string };
  BankAccount?: { AccountID?: string; Code?: string };
  FromBankAccount?: { AccountID?: string };
  ToBankAccount?: { AccountID?: string };
  UpdatedDateUTC?: string;
}

export interface XeroBuildOpts {
  /** Account Code → AccountID (line items reference codes). */
  accountIdByCode: Map<string, string>;
  /** The GST/tax system account (RECEIVE-deposit tax source line). */
  gstAccountRef?: string;
}

const CANCELLED = new Set(["VOIDED", "DELETED"]);
const POSTED = new Set(["AUTHORISED", "PAID", "POSTED"]);

/**
 * Every target-type value Xero's published Accounting API contract defines
 * for the four payment targets (the `Type` enums on the Invoice, CreditNote,
 * Prepayment and Overpayment schemas in XeroAPI/xero-openapi
 * `xero_accounting.yaml`).
 */
export type XeroPaymentTargetType =
  | "ACCREC" | "ACCPAY"
  | "ACCRECCREDIT" | "ACCPAYCREDIT"
  | "AROVERPAYMENT" | "APOVERPAYMENT"
  | "ARPREPAYMENT" | "APPREPAYMENT"
  | "RECEIVE-PREPAYMENT" | "SPEND-PREPAYMENT"
  | "RECEIVE-OVERPAYMENT" | "SPEND-OVERPAYMENT";

const XERO_PAYMENT_TARGET_TYPES: ReadonlySet<string> = new Set<string>([
  "ACCREC", "ACCPAY",
  "ACCRECCREDIT", "ACCPAYCREDIT",
  "AROVERPAYMENT", "APOVERPAYMENT",
  "ARPREPAYMENT", "APPREPAYMENT",
  "RECEIVE-PREPAYMENT", "SPEND-PREPAYMENT",
  "RECEIVE-OVERPAYMENT", "SPEND-OVERPAYMENT",
]);

/**
 * AR/AP side of one known target type. The `never` arm refuses to compile
 * when Xero adds a target type without a mapping here.
 */
export function xeroPaymentKindForTarget(
  type: XeroPaymentTargetType,
): "customer_payment" | "vendor_payment" {
  switch (type) {
    case "ACCREC":
    case "ACCRECCREDIT":
    case "AROVERPAYMENT":
    case "ARPREPAYMENT":
    case "RECEIVE-OVERPAYMENT":
    case "RECEIVE-PREPAYMENT":
      return "customer_payment";
    case "ACCPAY":
    case "ACCPAYCREDIT":
    case "APOVERPAYMENT":
    case "APPREPAYMENT":
    case "SPEND-OVERPAYMENT":
    case "SPEND-PREPAYMENT":
      return "vendor_payment";
    default: {
      const _exhaustive: never = type;
      throw new Error(`unrecognized Xero payment target type ${String(_exhaustive)}`);
    }
  }
}

/**
 * PaymentType family fallback (same contract, `Payment` schema `PaymentType`
 * enum: ACCRECPAYMENT, ACCPAYPAYMENT, ARCREDITPAYMENT, APCREDITPAYMENT,
 * AROVERPAYMENTPAYMENT, ARPREPAYMENTPAYMENT, APPREPAYMENTPAYMENT,
 * APOVERPAYMENTPAYMENT). Used only when the settled target carries no known
 * type — a payment whose side neither the target nor the family names is
 * refused, never guessed.
 */
export function xeroPaymentKindForPaymentType(
  paymentType: string | undefined,
): "customer_payment" | "vendor_payment" | null {
  if (!paymentType) return null;
  if (/^(AR|ACCREC)/.test(paymentType)) return "customer_payment";
  if (/^(AP|ACCPAY)/.test(paymentType)) return "vendor_payment";
  return null;
}

/**
 * Which side of the books a Xero payment settles. Payments against credit
 * notes, prepayments and overpayments carry those pointers instead of
 * `Invoice` — keying only on `Invoice.Type` mapped every one of them to
 * `vendor_payment`, so customer refunds landed in AP.
 */
export function xeroPaymentKind(
  t: XeroDoc,
): "customer_payment" | "vendor_payment" | { skip: string } {
  const targets = [
    t.Invoice?.InvoiceID ? { label: `Invoice:${t.Invoice.InvoiceID}`, type: t.Invoice.Type } : null,
    t.CreditNote?.CreditNoteID ? { label: `CreditNote:${t.CreditNote.CreditNoteID}`, type: t.CreditNote.Type } : null,
    t.Prepayment?.PrepaymentID ? { label: `Prepayment:${t.Prepayment.PrepaymentID}`, type: t.Prepayment.Type } : null,
    t.Overpayment?.OverpaymentID ? { label: `Overpayment:${t.Overpayment.OverpaymentID}`, type: t.Overpayment.Type } : null,
  ].filter((x): x is { label: string; type: string | undefined } => x !== null);
  if (targets.length === 0) {
    return { skip: "payment without a target invoice, credit note, prepayment or overpayment" };
  }
  if (targets.length > 1) {
    return { skip: `payment settles multiple documents (${targets.map((x) => x.label).join(", ")})` };
  }
  const target = targets[0]!;
  if (target.type && XERO_PAYMENT_TARGET_TYPES.has(target.type)) {
    return xeroPaymentKindForTarget(target.type as XeroPaymentTargetType);
  }
  const fallback = xeroPaymentKindForPaymentType(t.PaymentType);
  if (fallback) return fallback;
  return {
    skip: `unrecognized Xero payment target type ${target.type ?? "(missing)"} with PaymentType ${t.PaymentType ?? "(missing)"}`,
  };
}

/** Xero date fields: prefer DateString (local ISO); fall back to /Date(ms)/. */
function isoDay(d?: string, fallback?: string): string | null {
  const v = d ?? fallback;
  if (!v) return null;
  const m = v.match(/\/Date\((\d+)/);
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  return v.slice(0, 10);
}

export function buildNativeFromXero(
  ctx: NativeContext,
  entity: string,
  t: XeroDoc,
  opts: XeroBuildOpts,
): NativeDocument | { skip: string } {
  // BankTransfers carry no Status in Xero — they are posted by existence.
  const status = t.Status ?? (entity === "BankTransfer" ? "AUTHORISED" : "");
  if (CANCELLED.has(status)) return { skip: "cancelled" };
  if (!POSTED.has(status)) return { skip: `status=${status}` };

  const rate = t.CurrencyRate && t.CurrencyRate > 0 ? t.CurrencyRate : 1;
  const home = (v: number | undefined): bigint => toUnits(mulDecimal(String(v ?? 0), String(rate)));
  const byCode = (code?: string): string | null =>
    code ? ctx.accountByRef.get(opts.accountIdByCode.get(code) ?? "")?.id ?? null : null;
  const byId = (id?: string): string | null => (id ? ctx.accountByRef.get(id)?.id ?? null : null);

  const id =
    t.InvoiceID ?? t.CreditNoteID ?? t.PaymentID ?? t.ManualJournalID ?? t.BankTransactionID ?? t.BankTransferID;
  if (!id) return { skip: "missing id" };
  const sourceRef = `${entity}:${id}`;
  const base = {
    sourceRef,
    posting: true,
    documentDate: isoDay(t.DateString, t.Date) ?? "",
    dueDate: isoDay(t.DueDateString) ?? null,
    memo: t.Reference ?? t.Narration ?? null,
    referenceNumber: t.InvoiceNumber ?? t.CreditNoteNumber ?? t.Reference ?? sourceRef,
  };
  if (!base.documentDate) return { skip: "missing date" };
  let n = 0;
  const mk = (accountId: string, units: bigint, description: string | null = null): NativeDocLine => ({
    accountId, itemId: null, amount: fromUnits(units),
    taxAmount: "0", taxOverridden: false, taxCodeId: null,
    departmentId: null, projectId: null, description, lineNumber: ++n,
  });

  /** Detail lines from LineItems; tax is grouped per TaxType on its first line. */
  const detail = (): NativeDocLine[] | { skip: string } => {
    const out: NativeDocLine[] = [];
    const taxByType = new Map<string, { amount: bigint; carrier: NativeDocLine }>();
    for (const l of t.LineItems ?? []) {
      const a = byCode(l.AccountCode);
      if (!a) return { skip: `unmapped account code ${l.AccountCode}` };
      out.push(mk(a, home(l.LineAmount), l.Description ?? null));
      // Tax keeps its sign: a −20 line with −2 tax is a reduction of the
      // +100/+10 line, so the bucket nets to 8 — abs()'ing here overstated
      // AR and tax (12) and flipped credit-note tax outright.
      const tax = home(l.TaxAmount);
      if (tax !== 0n && l.TaxType) {
        const bucket = taxByType.get(l.TaxType);
        if (bucket) {
          bucket.amount += tax;
        } else {
          taxByType.set(l.TaxType, {
            amount: tax,
            carrier: out[out.length - 1]!,
          });
        }
      }
    }
    if (out.length === 0) return { skip: "no line items" };
    for (const [taxType, bucket] of taxByType) {
      const carrier = bucket.carrier;
      carrier.taxAmount = fromUnits(toUnits(carrier.taxAmount) + bucket.amount);
      carrier.taxOverridden = true;
      if (!carrier.taxCodeId) carrier.taxCodeId = ctx.taxCodeByRef.get(taxType) ?? null;
    }
    return out;
  };
  const party = ctx.partyByRef.get(t.Contact?.ContactID ?? "") ?? null;

  switch (entity) {
    case "Invoice": {
      const lines = detail();
      if ("skip" in lines) return lines;
      return {
        ...base,
        kind: t.Type === "ACCREC" ? "customer_invoice" : "vendor_bill",
        partyId: party,
        controlAccountId: null, // Xero has single system Debtors/Creditors
        lines,
      };
    }
    case "CreditNote": {
      const lines = detail();
      if ("skip" in lines) return lines;
      return {
        ...base,
        kind: t.Type === "ACCRECCREDIT" ? "customer_credit" : "vendor_credit",
        partyId: party,
        controlAccountId: null,
        lines,
      };
    }
    case "Payment": {
      const counter = byId(t.Account?.AccountID) ?? byCode(t.Account?.Code);
      if (!counter) return { skip: "payment without bank account" };
      const kind = xeroPaymentKind(t);
      if (typeof kind !== "string") return kind;
      return {
        ...base,
        kind,
        partyId: party,
        controlAccountId: null,
        lines: [mk(counter, home(t.Amount))],
      };
    }
    case "ManualJournal": {
      const lines: NativeDocLine[] = [];
      for (const l of t.JournalLines ?? []) {
        const a = byCode(l.AccountCode);
        if (!a) return { skip: `unmapped account code ${l.AccountCode}` };
        const amt = home(l.LineAmount); // + debit / − credit
        if (amt === 0n) continue;
        lines.push(mk(a, amt, l.Description ?? null));
      }
      if (lines.length < 2) return { skip: "journal with fewer than 2 lines" };
      return { ...base, kind: "journal", partyId: null, controlAccountId: null, lines };
    }
    case "BankTransaction": {
      const bank = byId(t.BankAccount?.AccountID) ?? byCode(t.BankAccount?.Code);
      if (!bank) return { skip: "bank transaction without bank account" };
      if (t.Type === "SPEND" || t.Type === "RECEIVE") {
        const lines = detail();
        if ("skip" in lines) return lines;
        // Xero states reconciliation per bank transaction (IsReconciled), not
        // per line: every leg shares the header state, dated at the bank
        // transaction date (Xero states no clear date). The engine stamps
        // only reconcilable accounts, so sharing is exact, not approximate.
        const cleared = t.IsReconciled === true;
        const clearedDate = cleared ? (isoDay(t.DateString, t.Date) ?? base.documentDate) : null;
        for (const line of lines) {
          line.sourceCleared = cleared;
          line.sourceClearedDate = clearedDate;
        }
        if (t.Type === "SPEND") {
          // check rule: DR lines (+ tax via codes), CR bank (control override).
          return { ...base, kind: "check", partyId: party, controlAccountId: bank, lines };
        }
        // RECEIVE → deposit rule: DR bank (control), CR each source. Tax has no
        // rule leg on deposits — post it as an explicit source on the GST account.
        for (const l of lines) {
          if (toUnits(l.taxAmount) !== 0n && opts.gstAccountRef) {
            const gst = ctx.accountByRef.get(opts.gstAccountRef)?.id;
            if (gst) lines.push(mk(gst, toUnits(l.taxAmount), "Tax on receive"));
            l.taxAmount = "0";
            l.taxOverridden = false;
            l.taxCodeId = null;
          }
        }
        return { ...base, kind: "deposit", partyId: party, controlAccountId: bank, lines };
      }
      return { skip: `bank transaction type ${t.Type}` }; // transfers ride BankTransfer
    }
    case "BankTransfer": {
      const to = byId(t.ToBankAccount?.AccountID);
      const from = byId(t.FromBankAccount?.AccountID);
      if (!to || !from) return { skip: "unmapped transfer account" };
      return {
        ...base,
        kind: "transfer",
        partyId: null,
        controlAccountId: null,
        lines: [mk(to, home(t.Amount)), mk(from, 0n)],
      };
    }
    default:
      return { skip: `unhandled entity ${entity}` };
  }
}
