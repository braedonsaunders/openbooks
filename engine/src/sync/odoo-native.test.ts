import assert from "node:assert/strict";
import test from "node:test";
import type { NativeContext } from "./native.ts";
import { buildNativeFromOdoo, type OdooMove, type OdooMoveLine } from "./odoo-native.ts";

/**
 * Odoo native-document tax signs (D3): tax move lines carry the same
 * debit/credit sign as the detail lines, so the adapter converts them with
 * the document kind's DETAIL_SIGN — exactly like the details — instead of
 * abs()'ing each line. Opposite-sign tax lines for one tax net instead of
 * inflating, and standard documents are untouched.
 */
function taxCtx(): NativeContext {
  return {
    accountByRef: new Map([
      ["11", { id: "ob-11", number: "1100", name: "Receivable", type: "asset_receivable" }],
      ["20", { id: "ob-20", number: "4000", name: "Sales", type: "income" }],
      ["30", { id: "ob-30", number: "2100", name: "Tax payable", type: "liability_current_other" }],
    ]),
    partyByRef: new Map(),
    taxByRate: new Map([["10.0000", { id: "tax-10", rate: "10.0000" }]]),
  } as unknown as NativeContext;
}

function invoiceMove(): OdooMove {
  return {
    id: 501, name: "INV/001", move_type: "out_invoice", state: "posted",
    partner_id: false, invoice_date: "2026-08-27", invoice_date_due: "2026-09-27",
    date: "2026-08-27", ref: false, payment_id: false,
    statement_line_id: false, write_date: "2026-08-28 10:00:00",
  };
}

function line(partial: Partial<OdooMoveLine> & { id: number }): OdooMoveLine {
  return {
    move_id: [501, "INV/001"], account_id: [20, "Sales"], name: "item",
    balance: 0, display_type: "product", tax_ids: [], tax_line_id: false,
    partner_id: false,
    ...partial,
  };
}

const opts = () => ({ paymentPartnerType: new Map(), taxRateById: new Map([[7, 10]]) });

test("Odoo invoice tax keeps its sign across a reduction tax line", () => {
  const lines: OdooMoveLine[] = [
    line({ id: 601, account_id: [20, "Sales"], balance: -100, tax_ids: [7] }),
    // Odoo nets the discount into the per-tax total as its own tax line with
    // the opposite debit/credit sign: −10 on the +100 line, +2 back.
    line({ id: 602, account_id: [30, "Tax payable"], balance: -10, display_type: "tax", tax_ids: [], tax_line_id: [7, "Tax 10%"] }),
    line({ id: 603, account_id: [30, "Tax payable"], balance: 2, display_type: "tax", tax_ids: [], tax_line_id: [7, "Tax 10%"] }),
    line({ id: 604, account_id: [11, "Receivable"], balance: 108, display_type: "payment_term", name: "receivable" }),
  ];
  const built = buildNativeFromOdoo(taxCtx(), invoiceMove(), lines, opts());
  assert.ok(!("skip" in built));
  const carrier = built.lines.find((l) => l.taxCodeId === "tax-10")!;
  assert.ok(carrier, "the tax attaches to its carrier line");
  // Nets to 8 (the −10 and +2 cancel); abs()'ing posted 12.
  assert.equal(carrier.taxAmount, "8.0000");
  assert.equal(carrier.taxOverridden, true);
});

test("Odoo standard single-line tax is untouched by signed aggregation", () => {
  const lines: OdooMoveLine[] = [
    line({ id: 601, account_id: [20, "Sales"], balance: -100, tax_ids: [7] }),
    line({ id: 602, account_id: [30, "Tax payable"], balance: -10, display_type: "tax", tax_ids: [], tax_line_id: [7, "Tax 10%"] }),
    line({ id: 604, account_id: [11, "Receivable"], balance: 110, display_type: "payment_term", name: "receivable" }),
  ];
  const built = buildNativeFromOdoo(taxCtx(), invoiceMove(), lines, opts());
  assert.ok(!("skip" in built));
  const carrier = built.lines.find((l) => l.taxCodeId === "tax-10")!;
  assert.equal(carrier!.taxAmount, "10.0000");
});
