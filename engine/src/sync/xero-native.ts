import { fromUnits, toUnits } from "../money.ts";
import type { NativeContext, NativeDocLine, NativeDocument } from "./native.ts";

/**
 * Xero → native openbooks documents:
 *
 *   Invoice ACCREC      → customer_invoice    Invoice ACCPAY      → vendor_bill
 *   CreditNote ACCRECCREDIT → customer_credit ACCPAYCREDIT        → vendor_credit
 *   Payment (by invoice type) → customer/vendor_payment
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

export interface XeroDoc {
  InvoiceID?: string;
  CreditNoteID?: string;
  PaymentID?: string;
  ManualJournalID?: string;
  BankTransactionID?: string;
  BankTransferID?: string;
  Type?: string;
  Status?: string;
  Contact?: { ContactID?: string };
  DateString?: string;
  Date?: string;
  DueDateString?: string;
  InvoiceNumber?: string;
  CreditNoteNumber?: string;
  Reference?: string;
  Narration?: string;
  LineItems?: XeroLineItem[];
  JournalLines?: { LineAmount?: number; AccountCode?: string; Description?: string }[];
  CurrencyRate?: number;
  Total?: number;
  TotalTax?: number;
  Amount?: number;
  Invoice?: { InvoiceID?: string; Type?: string };
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
  const home = (v: number | undefined): bigint => toUnits(((v ?? 0) * rate).toFixed(2));
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

  /** Detail lines from LineItems; per-line tax grouped per TaxType. */
  const detail = (): NativeDocLine[] | { skip: string } => {
    const out: NativeDocLine[] = [];
    const taxByType = new Map<string, bigint>();
    for (const l of t.LineItems ?? []) {
      const a = byCode(l.AccountCode);
      if (!a) return { skip: `unmapped account code ${l.AccountCode}` };
      out.push(mk(a, home(l.LineAmount), l.Description ?? null));
      const tax = home(l.TaxAmount);
      if (tax !== 0n && l.TaxType) {
        taxByType.set(l.TaxType, (taxByType.get(l.TaxType) ?? 0n) + (tax < 0n ? -tax : tax));
      }
    }
    if (out.length === 0) return { skip: "no line items" };
    for (const [taxType, amt] of taxByType) {
      const carrier = out[0]!;
      carrier.taxAmount = fromUnits(toUnits(carrier.taxAmount) + amt);
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
      const isAR = (t.Invoice?.Type ?? "").startsWith("ACCREC");
      return {
        ...base,
        kind: isAR ? "customer_payment" : "vendor_payment",
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
