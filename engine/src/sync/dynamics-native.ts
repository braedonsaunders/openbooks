import { fromUnits, toUnits } from "../money.ts";
import type { NativeContext, NativeDocLine, NativeDocument } from "./native.ts";

/**
 * Dynamics 365 Business Central → native openbooks documents:
 *
 *   salesInvoice        → customer_invoice   purchaseInvoice     → vendor_bill
 *   salesCreditMemo     → customer_credit    purchaseCreditMemo  → vendor_credit
 *   customerPayment     → customer_payment   vendorPayment       → vendor_payment
 *   journal line batch  → journal
 *
 * Document detail lines come from the v2.0 line entities. Account-type lines
 * carry `accountId` directly; Item/Resource lines don't expose their posting
 * account in the API, so the adapter supplies an item→GL-account map resolved
 * from posting setup — an unresolved item line makes the doc `unbuildable`
 * (surfaced, never silently dropped). Tax rides per-line `totalTaxAmount`.
 */

export interface BCLine {
  id?: string;
  sequence?: number;
  lineType?: string; // "Account" | "Item" | "Resource" | "Comment" | "Charge" | ...
  lineObjectNumber?: string;
  accountId?: string;
  itemId?: string;
  description?: string;
  amountExcludingTax?: number;
  totalTaxAmount?: number;
  taxCode?: string;
  netAmount?: number;
}

export interface BCDoc {
  id?: string;
  number?: string;
  externalDocumentNumber?: string;
  invoiceDate?: string;
  creditMemoDate?: string;
  postingDate?: string;
  dueDate?: string;
  documentDate?: string;
  status?: string; // "Draft" | "Open" | "Paid" | "Corrective" | "Canceled" ...
  customerId?: string;
  vendorId?: string;
  totalAmountExcludingTax?: number;
  totalTaxAmount?: number;
  totalAmountIncludingTax?: number;
  remainingAmount?: number;
  // payment-journal shapes
  journalId?: string;
  amount?: number;
  appliesToInvoiceId?: string;
  accountType?: string;
  accountId?: string; // balancing (bank) account for payments
  contactId?: string;
  lines?: BCLine[];
  lastModifiedDateTime?: string;
}

export interface BCBuildOpts {
  /** Item id → its GL posting account id (sales or purchase side by doc kind). */
  itemSalesAccount: Map<string, string>;
  itemPurchaseAccount: Map<string, string>;
  /** documentNumber → the income/expense openbooks account id BC actually used
   *  (from generalLedgerEntries) — resolves item lines whose account the API
   *  omits. Any residual account-distribution error is closed by the GL trueup. */
  docIncomeAccount?: Map<string, string>;
  docExpenseAccount?: Map<string, string>;
}

const CANCELLED = new Set(["Canceled", "Cancelled"]);
const isoDay = (v?: string): string | null => (v ? v.slice(0, 10) : null);

export function buildNativeFromBC(
  ctx: NativeContext,
  entity: string,
  t: BCDoc,
  opts: BCBuildOpts,
): NativeDocument | { skip: string } {
  if (t.status && CANCELLED.has(t.status)) return { skip: "cancelled" };
  // Draft documents aren't posted — they have no GL impact and their line
  // amounts may be uncalculated. The posted GL (and trueup) already covers them.
  if (t.status === "Draft") return { skip: "draft (unposted, no GL)" };
  const id = t.id;
  if (!id) return { skip: "missing id" };
  const sourceRef = `${entity}:${id}`;
  const home = (v: number | undefined): bigint => toUnits(String(v ?? 0));
  const byId = (aid?: string): string | null => (aid ? ctx.accountByRef.get(aid)?.id ?? null : null);

  const docDate = isoDay(t.invoiceDate ?? t.creditMemoDate ?? t.postingDate ?? t.documentDate);
  if (!docDate) return { skip: "missing date" };
  const base = {
    sourceRef,
    posting: true,
    documentDate: docDate,
    dueDate: isoDay(t.dueDate),
    memo: t.externalDocumentNumber ?? null,
    referenceNumber: t.number ?? sourceRef,
  };
  let n = 0;
  const mk = (accountId: string, units: bigint, description: string | null = null): NativeDocLine => ({
    accountId, itemId: null, amount: fromUnits(units), taxAmount: "0", taxOverridden: false,
    taxCodeId: null, departmentId: null, projectId: null, description, lineNumber: ++n,
  });

  /** Detail lines from a document's line entities (income/expense side only). */
  const detail = (side: "sales" | "purchase"): NativeDocLine[] | { skip: string } => {
    const out: NativeDocLine[] = [];
    const taxByCode = new Map<string, bigint>();
    for (const l of t.lines ?? []) {
      if (l.lineType === "Comment" || (l.amountExcludingTax ?? 0) === 0) continue;
      let acct: string | null = null;
      if (l.lineType === "Account") acct = byId(l.accountId);
      else if (l.lineType === "Item" && l.itemId) {
        const ref = (side === "sales" ? opts.itemSalesAccount : opts.itemPurchaseAccount).get(l.itemId);
        // API omits the item line's account → fall back to the account BC posted
        // this document to in the GL (per-document income/expense).
        acct =
          (ref ? byId(ref) : null) ??
          (side === "sales" ? opts.docIncomeAccount : opts.docExpenseAccount)?.get(t.number ?? "") ??
          null;
      } else if (l.accountId) acct = byId(l.accountId);
      if (!acct) return { skip: `unresolved ${l.lineType} line account (${l.lineObjectNumber ?? l.itemId ?? "?"})` };
      out.push(mk(acct, home(l.amountExcludingTax), l.description ?? null));
      const tax = home(l.totalTaxAmount);
      if (tax !== 0n && l.taxCode) taxByCode.set(l.taxCode, (taxByCode.get(l.taxCode) ?? 0n) + (tax < 0n ? -tax : tax));
    }
    if (out.length === 0) return { skip: "no detail lines" };
    for (const [code, amt] of taxByCode) {
      const carrier = out[0]!;
      carrier.taxAmount = fromUnits(toUnits(carrier.taxAmount) + amt);
      carrier.taxOverridden = true;
      if (!carrier.taxCodeId) carrier.taxCodeId = ctx.taxCodeByRef.get(code) ?? null;
    }
    return out;
  };

  switch (entity) {
    case "salesInvoice":
    case "purchaseInvoice": {
      const side = entity === "salesInvoice" ? "sales" : "purchase";
      const lines = detail(side);
      if ("skip" in lines) return lines;
      return {
        ...base,
        kind: side === "sales" ? "customer_invoice" : "vendor_bill",
        partyId: ctx.partyByRef.get((side === "sales" ? t.customerId : t.vendorId) ?? "") ?? null,
        controlAccountId: null,
        lines,
      };
    }
    case "salesCreditMemo":
    case "purchaseCreditMemo": {
      const side = entity === "salesCreditMemo" ? "sales" : "purchase";
      const lines = detail(side);
      if ("skip" in lines) return lines;
      return {
        ...base,
        kind: side === "sales" ? "customer_credit" : "vendor_credit",
        partyId: ctx.partyByRef.get((side === "sales" ? t.customerId : t.vendorId) ?? "") ?? null,
        controlAccountId: null,
        lines,
      };
    }
    case "customerPayment":
    case "vendorPayment": {
      const bank = byId(t.accountId);
      if (!bank) return { skip: "payment without bank account" };
      const isAR = entity === "customerPayment";
      return {
        ...base,
        kind: isAR ? "customer_payment" : "vendor_payment",
        partyId: ctx.partyByRef.get((isAR ? t.customerId : t.vendorId) ?? t.contactId ?? "") ?? null,
        controlAccountId: null,
        lines: [mk(bank, home(t.amount))],
      };
    }
    case "journal": {
      const lines: NativeDocLine[] = [];
      for (const l of t.lines ?? []) {
        const a = byId(l.accountId);
        if (!a) return { skip: `unresolved journal account ${l.lineObjectNumber ?? "?"}` };
        const amt = home(l.netAmount ?? l.amountExcludingTax); // + debit / − credit
        if (amt === 0n) continue;
        lines.push(mk(a, amt, l.description ?? null));
      }
      if (lines.length < 2) return { skip: "journal with fewer than 2 lines" };
      return { ...base, kind: "journal", partyId: null, controlAccountId: null, lines };
    }
    default:
      return { skip: `unhandled entity ${entity}` };
  }
}
