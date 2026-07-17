import { fromUnits, toUnits } from "../money.ts";
import type { NativeContext, NativeDocLine, NativeDocument } from "./native.ts";

/**
 * QuickBooks Online → native openbooks documents. QBO entities map directly:
 *
 *   Invoice        → customer_invoice   CreditMemo   → customer_credit
 *   Bill           → vendor_bill        VendorCredit → vendor_credit
 *   Payment        → customer_payment   BillPayment  → vendor_payment
 *   JournalEntry   → journal            Deposit      → deposit
 *   Purchase       → check / card_charge (PaymentType)   Transfer → transfer
 *   SalesReceipt / RefundReceipt → journal (exact GL pass-through)
 *
 * Invoice/receipt lines reference ITEMS; their income/expense accounts come
 * from the item maps the adapter provides. Tax rides TxnTaxDetail at QBO's
 * ACTUAL per-rate amounts (TaxRateRef → ref-keyed tax code). Amounts are
 * converted to home currency via ExchangeRate (multicurrency companies),
 * rounded per line to match QBO's own home-currency postings.
 */

interface Ref { value: string; name?: string }
interface LinkedTxn { TxnId: string; TxnType: string }
export interface QboTxnBase {
  Id: string;
  TxnDate: string;
  DocNumber?: string;
  PrivateNote?: string;
  CurrencyRef?: Ref;
  ExchangeRate?: number;
  MetaData?: { LastUpdatedTime?: string };
}
export interface QboLine {
  Id?: string;
  Amount?: number;
  Description?: string;
  DetailType: string;
  SalesItemLineDetail?: { ItemRef?: Ref; ItemAccountRef?: Ref; TaxCodeRef?: Ref };
  ItemBasedExpenseLineDetail?: { ItemRef?: Ref; ItemAccountRef?: Ref };
  AccountBasedExpenseLineDetail?: { AccountRef?: Ref };
  DiscountLineDetail?: { DiscountAccountRef?: Ref };
  JournalEntryLineDetail?: { PostingType?: string; AccountRef?: Ref };
  DepositLineDetail?: { AccountRef?: Ref };
  LinkedTxn?: LinkedTxn[];
}
export interface QboTxn extends QboTxnBase {
  CustomerRef?: Ref;
  VendorRef?: Ref;
  DueDate?: string;
  Line?: QboLine[];
  TxnTaxDetail?: { TotalTax?: number; TaxLine?: { Amount?: number; TaxLineDetail?: { TaxRateRef?: Ref } }[] };
  APAccountRef?: Ref;
  ARAccountRef?: Ref;
  DepositToAccountRef?: Ref;
  TotalAmt?: number;
  PayType?: string; // BillPayment: Check | CreditCard
  CheckPayment?: { BankAccountRef?: Ref };
  CreditCardPayment?: { CCAccountRef?: Ref };
  PaymentType?: string; // Purchase: Cash | Check | CreditCard
  AccountRef?: Ref; // Purchase: the bank / card account
  Credit?: boolean; // Purchase refund
  FromAccountRef?: Ref;
  ToAccountRef?: Ref;
  Amount?: number; // Transfer
  // TaxPayment (sales-tax remittance to the agency)
  PaymentDate?: string;
  PaymentAccountRef?: Ref;
  PaymentAmount?: number;
  Refund?: boolean;
}

export interface QboBuildOpts {
  /** QBO item id → QBO income / expense ACCOUNT id (from the Item register). */
  itemIncomeAccount: Map<string, string>;
  itemExpenseAccount: Map<string, string>;
  /** The company's Undeposited Funds account ref (deposit LinkedTxn lines). */
  undepositedFundsRef?: string;
  /** GST/HST Suspense account ref — where filed tax + remittances post. */
  taxSuspenseRef?: string;
}

const isVoided = (t: QboTxnBase) => /voided/i.test(t.PrivateNote ?? "");

export function buildNativeFromQbo(
  ctx: NativeContext,
  entity: string,
  t: QboTxn,
  opts: QboBuildOpts,
): NativeDocument | { skip: string } {
  if (isVoided(t)) return { skip: "cancelled" };
  // Post in the TRANSACTION currency and let the engine translate + settle FX.
  // QBO amounts are already in the txn currency; ExchangeRate is txn→home.
  const currency = t.CurrencyRef?.value || ctx.baseCurrency;
  const fxRate = t.ExchangeRate && t.ExchangeRate > 0 ? String(t.ExchangeRate) : "1";
  const txn = (v: number | undefined): bigint => toUnits((v ?? 0).toFixed(2));
  const acct = (ref?: Ref): string | null => (ref?.value ? ctx.accountByRef.get(ref.value)?.id ?? null : null);
  const sourceRef = `${entity}:${t.Id}`;
  const base = {
    sourceRef,
    posting: true,
    currency,
    fxRate,
    documentDate: t.TxnDate,
    dueDate: t.DueDate ?? null,
    memo: t.PrivateNote ?? null,
    referenceNumber: t.DocNumber ?? sourceRef,
  };
  let n = 0;
  const mk = (accountId: string, units: bigint, description: string | null = null): NativeDocLine => ({
    accountId, itemId: null, amount: fromUnits(units),
    taxAmount: "0", taxOverridden: false, taxCodeId: null,
    departmentId: null, projectId: null, description, lineNumber: ++n,
  });

  /** Detail lines for item/account-based documents, positive convention. */
  const detailLines = (income: boolean, sign: 1n | -1n): NativeDocLine[] | { skip: string } => {
    const out: NativeDocLine[] = [];
    for (const l of t.Line ?? []) {
      if (l.DetailType === "SalesItemLineDetail") {
        // QBO populates ItemAccountRef (the posting account) directly on the
        // line — use it first. It's the only account on markup / billable-
        // expense lines, which carry no ItemRef. Fall back to the item register.
        const d = l.SalesItemLineDetail;
        const a =
          acct(d?.ItemAccountRef) ??
          (d?.ItemRef?.value
            ? ctx.accountByRef.get((income ? opts.itemIncomeAccount : opts.itemExpenseAccount).get(d.ItemRef.value) ?? "")?.id ?? null
            : null);
        if (!a) return { skip: `unmapped item ${d?.ItemRef?.value ?? "(markup/no item)"}` };
        out.push(mk(a, txn(l.Amount) * sign, l.Description ?? null));
      } else if (l.DetailType === "ItemBasedExpenseLineDetail") {
        const d = l.ItemBasedExpenseLineDetail;
        const a =
          acct(d?.ItemAccountRef) ??
          (d?.ItemRef?.value ? ctx.accountByRef.get(opts.itemExpenseAccount.get(d.ItemRef.value) ?? "")?.id ?? null : null);
        if (!a) return { skip: `unmapped item ${d?.ItemRef?.value ?? "(no item)"}` };
        out.push(mk(a, txn(l.Amount) * sign, l.Description ?? null));
      } else if (l.DetailType === "AccountBasedExpenseLineDetail") {
        const a = acct(l.AccountBasedExpenseLineDetail?.AccountRef);
        if (!a) return { skip: `unmapped account ${l.AccountBasedExpenseLineDetail?.AccountRef?.value}` };
        out.push(mk(a, txn(l.Amount) * sign, l.Description ?? null));
      } else if (l.DetailType === "DiscountLineDetail") {
        const a = acct(l.DiscountLineDetail?.DiscountAccountRef);
        if (a) out.push(mk(a, -txn(l.Amount) * sign, l.Description ?? "Discount"));
      }
      // SubTotalLineDetail / DescriptionOnly are presentational — skipped.
    }
    if (out.length === 0) return { skip: "no detail lines" };
    return out;
  };

  /** Attach QBO's actual tax per rate to the first detail line. */
  const attachTax = (lines: NativeDocLine[]): void => {
    for (const tl of t.TxnTaxDetail?.TaxLine ?? []) {
      const amt = txn(tl.Amount);
      if (amt === 0n) continue;
      const a = amt < 0n ? -amt : amt;
      const carrier = lines[0]!;
      carrier.taxAmount = fromUnits(toUnits(carrier.taxAmount) + a);
      carrier.taxOverridden = true;
      if (!carrier.taxCodeId) {
        const rateRef = tl.TaxLineDetail?.TaxRateRef?.value;
        carrier.taxCodeId = (rateRef ? ctx.taxCodeByRef.get(rateRef) : undefined) ?? null;
      }
    }
  };

  switch (entity) {
    case "Invoice":
    case "CreditMemo": {
      const lines = detailLines(true, 1n);
      if ("skip" in lines) return lines;
      attachTax(lines);
      return {
        ...base,
        kind: entity === "Invoice" ? "customer_invoice" : "customer_credit",
        partyId: ctx.partyByRef.get(`C:${t.CustomerRef?.value}`) ?? null,
        controlAccountId: acct(t.ARAccountRef),
        lines,
      };
    }
    case "Bill":
    case "VendorCredit": {
      const lines = detailLines(false, 1n);
      if ("skip" in lines) return lines;
      attachTax(lines);
      return {
        ...base,
        kind: entity === "Bill" ? "vendor_bill" : "vendor_credit",
        partyId: ctx.partyByRef.get(`V:${t.VendorRef?.value}`) ?? null,
        controlAccountId: acct(t.APAccountRef),
        lines,
      };
    }
    case "Payment": {
      const counter = acct(t.DepositToAccountRef) ??
        (opts.undepositedFundsRef ? ctx.accountByRef.get(opts.undepositedFundsRef)?.id ?? null : null);
      if (!counter) return { skip: "payment without deposit-to account" };
      return {
        ...base,
        kind: "customer_payment",
        partyId: ctx.partyByRef.get(`C:${t.CustomerRef?.value}`) ?? null,
        controlAccountId: acct(t.ARAccountRef),
        lines: [mk(counter, txn(t.TotalAmt))],
      };
    }
    case "BillPayment": {
      const counter =
        t.PayType === "CreditCard" ? acct(t.CreditCardPayment?.CCAccountRef) : acct(t.CheckPayment?.BankAccountRef);
      if (!counter) return { skip: "bill payment without bank/card account" };
      return {
        ...base,
        kind: "vendor_payment",
        partyId: ctx.partyByRef.get(`V:${t.VendorRef?.value}`) ?? null,
        controlAccountId: acct(t.APAccountRef),
        lines: [mk(counter, txn(t.TotalAmt))],
      };
    }
    case "JournalEntry": {
      const lines: NativeDocLine[] = [];
      for (const l of t.Line ?? []) {
        if (l.DetailType !== "JournalEntryLineDetail") continue;
        const a = acct(l.JournalEntryLineDetail?.AccountRef);
        if (!a) return { skip: `unmapped account ${l.JournalEntryLineDetail?.AccountRef?.value}` };
        const amt = txn(l.Amount);
        if (amt === 0n) continue;
        lines.push(mk(a, l.JournalEntryLineDetail?.PostingType === "Credit" ? -amt : amt, l.Description ?? null));
      }
      if (lines.length < 2) return { skip: "journal with fewer than 2 lines" };
      return { ...base, kind: "journal", partyId: null, controlAccountId: null, lines };
    }
    case "Deposit": {
      const lines: NativeDocLine[] = [];
      for (const l of t.Line ?? []) {
        const direct = acct(l.DepositLineDetail?.AccountRef);
        const a =
          direct ??
          (l.LinkedTxn?.length && opts.undepositedFundsRef
            ? ctx.accountByRef.get(opts.undepositedFundsRef)?.id ?? null
            : null);
        if (!a) continue;
        lines.push(mk(a, txn(l.Amount), l.Description ?? null));
      }
      if (lines.length === 0) return { skip: "deposit has no source lines" };
      return { ...base, kind: "deposit", partyId: null, controlAccountId: acct(t.DepositToAccountRef), lines };
    }
    case "Purchase": {
      const sign = t.Credit ? -1n : 1n;
      const lines = detailLines(false, sign);
      if ("skip" in lines) return lines;
      attachTax(lines);
      return {
        ...base,
        kind: t.PaymentType === "CreditCard" ? (t.Credit ? "card_refund" : "card_charge") : "check",
        partyId: t.VendorRef ? ctx.partyByRef.get(`V:${t.VendorRef.value}`) ?? null : null,
        controlAccountId: acct(t.AccountRef),
        lines,
      };
    }
    case "Transfer": {
      const to = acct(t.ToAccountRef), from = acct(t.FromAccountRef);
      if (!to || !from) return { skip: "unmapped transfer account" };
      return {
        ...base, kind: "transfer", partyId: null, controlAccountId: null,
        lines: [mk(to, txn(t.Amount)), mk(from, 0n)],
      };
    }
    case "TaxPayment": {
      // Sales-tax remittance: DR the tax liability (GST/HST Payable), CR bank.
      // Refund reverses. Clears the collected/paid tax that accrued on sales/bills.
      const bank = acct(t.PaymentAccountRef);
      const taxAcct = (opts.taxSuspenseRef ? ctx.accountByRef.get(opts.taxSuspenseRef)?.id : null) ?? ctx.control.taxCollected ?? null;
      if (!bank || !taxAcct) return { skip: "tax payment missing bank or tax account" };
      const amt = txn(t.PaymentAmount);
      const [dr, cr] = t.Refund ? [bank, taxAcct] : [taxAcct, bank];
      return {
        ...base,
        documentDate: t.PaymentDate ?? base.documentDate,
        kind: "journal", partyId: null, controlAccountId: null,
        lines: [mk(dr, amt, "Sales tax remittance"), mk(cr, -amt, "Sales tax remittance")],
      };
    }
    case "SalesReceipt":
    case "RefundReceipt": {
      // Invoice+payment in one document: exact GL pass-through as a journal.
      const sign = entity === "SalesReceipt" ? 1n : -1n;
      const bank = acct(t.DepositToAccountRef) ??
        (opts.undepositedFundsRef ? ctx.accountByRef.get(opts.undepositedFundsRef)?.id ?? null : null);
      if (!bank) return { skip: "receipt without deposit-to account" };
      const lines: NativeDocLine[] = [mk(bank, txn(t.TotalAmt) * sign)];
      const detail = detailLines(true, 1n);
      if ("skip" in detail) return detail;
      for (const d of detail) lines.push({ ...d, amount: fromUnits(-toUnits(d.amount) * sign), lineNumber: ++n });
      for (const tl of t.TxnTaxDetail?.TaxLine ?? []) {
        const amt = txn(tl.Amount);
        if (amt === 0n) continue;
        const rateRef = tl.TaxLineDetail?.TaxRateRef?.value;
        const codeId = rateRef ? ctx.taxCodeByRef.get(rateRef) ?? null : null;
        // tax leg posts to the code's collected account via journal pass-through:
        // resolve the code's account is engine-side; here use control fallback by
        // marking a plain line on the org's taxCollected control.
        const taxAcct = ctx.control.taxCollected;
        if (taxAcct) {
          const row = mk(taxAcct, -amt * sign, "Sales tax");
          row.taxCodeId = codeId;
          lines.push(row);
        }
      }
      if (lines.length < 2) return { skip: "receipt with fewer than 2 lines" };
      return { ...base, kind: "journal", partyId: ctx.partyByRef.get(`C:${t.CustomerRef?.value}`) ?? null, controlAccountId: null, lines };
    }
    default:
      return { skip: `unhandled entity ${entity}` };
  }
}
