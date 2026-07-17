import { fromUnits, toUnits } from "../money.ts";
import { m2oId } from "../odoo.ts";
import type { NativeContext, NativeDocLine, NativeDocument } from "./native.ts";

/**
 * Odoo → native openbooks documents. Odoo's `account.move` IS the native
 * transaction (invoices, bills, refunds, payments and journals are all moves)
 * and its lines carry explicit `display_type` roles — product (detail), tax,
 * payment_term (the AR/AP control leg) — so reconstruction is direct:
 *
 *   move_type out_invoice → customer_invoice   (detail stored = −balance)
 *   move_type in_invoice  → vendor_bill        (detail stored = +balance)
 *   move_type out_refund  → customer_credit    (detail stored = +balance)
 *   move_type in_refund   → vendor_credit      (detail stored = −balance)
 *   entry + payment       → customer/vendor_payment (per partner_type)
 *   entry otherwise       → journal (pass-through, amount = balance)
 *
 * Tax is carried at Odoo's ACTUAL per-tax amounts (tax_overridden=true) so the
 * regenerated GL matches to the penny; the payment_term line's account becomes
 * the document's control override, reproducing Odoo's exact AR/AP routing.
 */

export interface OdooMove {
  id: number;
  name: string;
  move_type: string;
  state: string;
  partner_id: unknown;
  invoice_date: string | false;
  invoice_date_due: string | false;
  date: string;
  ref: string | false;
  payment_id: unknown;
  statement_line_id: unknown;
  write_date: string;
}

export interface OdooMoveLine {
  id: number;
  move_id: unknown;
  account_id: unknown;
  name: string | false;
  balance: number;
  display_type: string;
  tax_ids: number[];
  tax_line_id: unknown;
}

/** Stored-amount sign per kind (see posting rules): rule(detail) reproduces GL. */
const DETAIL_SIGN: Record<string, 1 | -1> = {
  customer_invoice: -1,
  vendor_bill: 1,
  customer_credit: 1,
  vendor_credit: -1,
};

const MOVE_KIND: Record<string, string> = {
  out_invoice: "customer_invoice",
  in_invoice: "vendor_bill",
  out_refund: "customer_credit",
  in_refund: "vendor_credit",
};

const num = (v: number): bigint => toUnits(v.toFixed(2));

export function buildNativeFromOdoo(
  ctx: NativeContext,
  move: OdooMove,
  lines: OdooMoveLine[],
  opts: {
    /** move id → payment partner_type ("customer" | "supplier"), for entry moves. */
    paymentPartnerType: Map<string, string>;
    /** Odoo tax id → rate percent (rate-keys into ctx.taxByRate). */
    taxRateById: Map<number, number>;
  },
): NativeDocument | { skip: string } {
  if (move.state !== "posted") {
    // "cancelled" is a signal: the engine flags a previously-imported doc
    // whose source was cancelled as deleted-at-source (report, never auto-void).
    return { skip: move.state === "cancel" ? "cancelled" : `state=${move.state}` };
  }

  const partyId = ctx.partyByRef.get(m2oId(move.partner_id) ?? "") ?? null;
  const base = {
    sourceRef: String(move.id),
    posting: true,
    partyId,
    documentDate: move.date,
    dueDate: move.invoice_date_due || null,
    memo: move.ref || null,
    referenceNumber: move.name,
    controlAccountId: null as string | null,
  };
  const acct = (l: OdooMoveLine): string | null =>
    ctx.accountByRef.get(m2oId(l.account_id) ?? "")?.id ?? null;
  const acctType = (l: OdooMoveLine): string | null =>
    ctx.accountByRef.get(m2oId(l.account_id) ?? "")?.type ?? null;

  // ---- payments & plain journals (entry moves) --------------------------------
  const kind = MOVE_KIND[move.move_type];
  if (!kind) {
    const partnerType = opts.paymentPartnerType.get(String(move.id));
    if (partnerType) {
      const docKind = partnerType === "customer" ? "customer_payment" : "vendor_payment";
      const controlType = partnerType === "customer" ? "asset_receivable" : "liability_payable";
      const ctrl = lines.find((l) => acctType(l) === controlType);
      const counter = lines.find((l) => acctType(l) !== controlType && l.balance !== 0);
      if (!ctrl || !counter) return { skip: "payment move without control/counter leg" };
      const ctrlAccount = acct(ctrl);
      const counterAccount = acct(counter);
      if (!ctrlAccount || !counterAccount) return { skip: "unmapped payment account" };
      const total = num(ctrl.balance);
      return {
        ...base,
        kind: docKind,
        controlAccountId: ctrlAccount,
        lines: [{
          accountId: counterAccount, itemId: null,
          amount: fromUnits(total < 0n ? -total : total),
          taxAmount: "0", taxOverridden: false, taxCodeId: null,
          departmentId: null, projectId: null,
          description: ctrl.name || null, lineNumber: 1,
        }],
      };
    }
    // Plain journal / bank-statement move: pass-through.
    const out: NativeDocLine[] = [];
    let n = 0;
    for (const l of lines) {
      if (num(l.balance) === 0n) continue;
      const a = acct(l);
      if (!a) return { skip: `unmapped account ${m2oId(l.account_id)}` };
      out.push({
        accountId: a, itemId: null, amount: fromUnits(num(l.balance)),
        taxAmount: "0", taxOverridden: false, taxCodeId: null,
        departmentId: null, projectId: null,
        description: l.name || null, lineNumber: ++n,
      });
    }
    if (out.length < 2) return { skip: "journal with fewer than 2 lines" };
    return { ...base, kind: "journal", lines: out };
  }

  // ---- standard documents (invoice / bill / credit) ----------------------------
  const sign = DETAIL_SIGN[kind]!;
  const detail: { row: NativeDocLine; taxIds: number[] }[] = [];
  const out: NativeDocLine[] = [];
  let n = 0;
  for (const l of lines) {
    if (l.display_type !== "product" && l.display_type !== "rounding") continue;
    const a = acct(l);
    if (!a) return { skip: `unmapped account ${m2oId(l.account_id)}` };
    const primaryTax = (l.tax_ids ?? [])[0];
    const rate = primaryTax !== undefined ? opts.taxRateById.get(primaryTax) : undefined;
    const code = rate !== undefined ? ctx.taxByRate.get(String(Math.round(rate))) : undefined;
    const row: NativeDocLine = {
      accountId: a, itemId: null,
      amount: fromUnits(num(l.balance) * BigInt(sign)),
      taxAmount: "0", taxOverridden: false,
      taxCodeId: code?.id ?? null,
      departmentId: null, projectId: null,
      description: l.name || null, lineNumber: ++n,
    };
    out.push(row);
    detail.push({ row, taxIds: l.tax_ids ?? [] });
  }
  if (out.length === 0) return { skip: "no detail lines" };

  // Odoo's ACTUAL tax per tax id → attach to the first detail line carrying it.
  const taxByTaxId = new Map<number, bigint>();
  for (const l of lines) {
    if (l.display_type !== "tax") continue;
    const taxId = Number(m2oId(l.tax_line_id) ?? 0);
    const cur = taxByTaxId.get(taxId) ?? 0n;
    const b = num(l.balance);
    taxByTaxId.set(taxId, cur + (b < 0n ? -b : b));
  }
  for (const [taxId, amt] of taxByTaxId) {
    if (amt === 0n) continue;
    const carrier =
      detail.find((d) => d.taxIds.includes(taxId)) ?? detail[0]!;
    const prev = toUnits(carrier.row.taxAmount);
    carrier.row.taxAmount = fromUnits(prev + amt);
    carrier.row.taxOverridden = true;
    if (!carrier.row.taxCodeId) {
      const rate = opts.taxRateById.get(taxId);
      carrier.row.taxCodeId =
        (rate !== undefined ? ctx.taxByRate.get(String(Math.round(rate)))?.id : undefined) ?? null;
    }
  }

  // Control override: the payment_term (AR/AP) line's account.
  const ctrlLine = lines.find((l) => l.display_type === "payment_term");
  const controlAccountId = ctrlLine ? acct(ctrlLine) : null;

  return { ...base, kind, controlAccountId, lines: out };
}
