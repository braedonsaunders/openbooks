import { fromUnits, toUnits } from "../money.ts";
import type { NativeContext, NativeDocLine, NativeDocument } from "./native.ts";

/**
 * ERPNext → native openbooks documents. Vouchers are first-class doctypes:
 *
 *   Sales Invoice            → customer_invoice   (detail = +base_net_amount)
 *   Sales Invoice is_return  → customer_credit    (detail = −base_net_amount)
 *   Purchase Invoice         → vendor_bill        (detail = +base_net_amount)
 *   Purchase Invoice return  → vendor_credit      (detail = −base_net_amount)
 *   Payment Entry Receive    → customer_payment   (counter = paid_to, control = paid_from)
 *   Payment Entry Pay        → vendor_payment     (counter = paid_from, control = paid_to)
 *   Payment Entry Internal   → transfer
 *   Journal Entry            → journal            (accounts[] debit − credit)
 *
 * Tax rides each voucher's `taxes[]` at ERPNext's ACTUAL base_tax_amount,
 * keyed by account_head → tax code (ref-keyed), so per-rate tax accounts
 * reproduce exactly through the per-code tax routing.
 */

export interface ErpInvoice {
  name: string;
  customer?: string;
  supplier?: string;
  posting_date: string;
  due_date?: string | null;
  is_return: 0 | 1;
  docstatus: number;
  debit_to?: string;
  credit_to?: string;
  remarks?: string | null;
  items: { item_code?: string | null; income_account?: string; expense_account?: string; base_net_amount: number; description?: string | null }[];
  taxes?: { account_head: string; base_tax_amount: number }[];
}

export interface ErpPayment {
  name: string;
  payment_type: string; // Receive | Pay | Internal Transfer
  party_type?: string | null;
  party?: string | null;
  posting_date: string;
  docstatus: number;
  paid_from: string;
  paid_to: string;
  base_paid_amount: number;
  base_received_amount: number;
  remarks?: string | null;
}

export interface ErpJournal {
  name: string;
  posting_date: string;
  docstatus: number;
  user_remark?: string | null;
  accounts: { account: string; debit: number; credit: number }[];
}

const num = (v: number): bigint => toUnits((v ?? 0).toFixed(2));

function line(
  accountId: string,
  amountUnits: bigint,
  n: number,
  description: string | null = null,
): NativeDocLine {
  return {
    accountId, itemId: null, amount: fromUnits(amountUnits),
    taxAmount: "0", taxOverridden: false, taxCodeId: null,
    departmentId: null, projectId: null, description, lineNumber: n,
  };
}

export function buildErpInvoice(ctx: NativeContext, inv: ErpInvoice): NativeDocument | { skip: string } {
  if (inv.docstatus !== 1) return { skip: inv.docstatus === 2 ? "cancelled" : `docstatus=${inv.docstatus}` };
  const isSales = inv.customer !== undefined && inv.customer !== null && inv.customer !== "";
  const kind = isSales
    ? (inv.is_return ? "customer_credit" : "customer_invoice")
    : (inv.is_return ? "vendor_credit" : "vendor_bill");
  const sign = inv.is_return ? -1n : 1n;
  const partyRef = isSales ? `C:${inv.customer}` : `S:${inv.supplier}`;
  const controlRef = isSales ? inv.debit_to : inv.credit_to;

  const lines: NativeDocLine[] = [];
  let n = 0;
  for (const it of inv.items) {
    const ref = isSales ? it.income_account : it.expense_account;
    const accountId = ctx.accountByRef.get(ref ?? "")?.id;
    if (!accountId) return { skip: `unmapped account ${ref}` };
    lines.push(line(accountId, num(it.base_net_amount) * sign, ++n, it.description || it.item_code || null));
  }
  if (lines.length === 0) return { skip: "no items" };

  // Tax at ERPNext's actual amounts, per account_head → tax code.
  const taxByHead = new Map<string, bigint>();
  for (const t of inv.taxes ?? []) {
    const b = num(t.base_tax_amount);
    taxByHead.set(t.account_head, (taxByHead.get(t.account_head) ?? 0n) + (b < 0n ? -b : b));
  }
  for (const [head, amt] of taxByHead) {
    if (amt === 0n) continue;
    const codeId = ctx.taxCodeByRef.get(head) ?? null;
    const carrier = lines[0]!;
    carrier.taxAmount = fromUnits(toUnits(carrier.taxAmount) + amt);
    carrier.taxOverridden = true;
    if (!carrier.taxCodeId) carrier.taxCodeId = codeId;
  }

  return {
    sourceRef: inv.name,
    kind,
    posting: true,
    partyId: ctx.partyByRef.get(partyRef) ?? null,
    documentDate: inv.posting_date,
    dueDate: inv.due_date || null,
    memo: inv.remarks || null,
    referenceNumber: inv.name,
    controlAccountId: ctx.accountByRef.get(controlRef ?? "")?.id ?? null,
    lines,
  };
}

export function buildErpPayment(ctx: NativeContext, p: ErpPayment): NativeDocument | { skip: string } {
  if (p.docstatus !== 1) return { skip: p.docstatus === 2 ? "cancelled" : `docstatus=${p.docstatus}` };
  const base = {
    sourceRef: p.name,
    posting: true,
    documentDate: p.posting_date,
    dueDate: null,
    memo: p.remarks || null,
    referenceNumber: p.name,
  };
  const from = ctx.accountByRef.get(p.paid_from)?.id;
  const to = ctx.accountByRef.get(p.paid_to)?.id;
  if (!from || !to) return { skip: "unmapped payment account" };

  if (p.payment_type === "Receive") {
    return {
      ...base,
      kind: "customer_payment",
      partyId: ctx.partyByRef.get(`C:${p.party}`) ?? null,
      controlAccountId: from, // the receivable being credited
      lines: [line(to, num(p.base_received_amount), 1)],
    };
  }
  if (p.payment_type === "Pay") {
    return {
      ...base,
      kind: "vendor_payment",
      partyId: ctx.partyByRef.get(`S:${p.party}`) ?? null,
      controlAccountId: to, // the payable being debited
      lines: [line(from, num(p.base_paid_amount), 1)],
    };
  }
  // Internal Transfer: DR paid_to, CR paid_from.
  return {
    ...base,
    kind: "transfer",
    partyId: null,
    controlAccountId: null,
    lines: [line(to, num(p.base_received_amount), 1), line(from, 0n, 2)],
  };
}

export function buildErpJournal(ctx: NativeContext, je: ErpJournal): NativeDocument | { skip: string } {
  if (je.docstatus !== 1) return { skip: je.docstatus === 2 ? "cancelled" : `docstatus=${je.docstatus}` };
  const lines: NativeDocLine[] = [];
  let n = 0;
  for (const row of je.accounts) {
    const accountId = ctx.accountByRef.get(row.account)?.id;
    if (!accountId) return { skip: `unmapped account ${row.account}` };
    const amt = num(row.debit) - num(row.credit);
    if (amt === 0n) continue;
    lines.push(line(accountId, amt, ++n));
  }
  if (lines.length < 2) return { skip: "journal with fewer than 2 lines" };
  return {
    sourceRef: je.name,
    kind: "journal",
    posting: true,
    partyId: null,
    documentDate: je.posting_date,
    dueDate: null,
    memo: je.user_remark || null,
    referenceNumber: je.name,
    controlAccountId: null,
    lines,
  };
}
