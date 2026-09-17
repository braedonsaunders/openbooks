import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
}});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { DOCUMENT_BUILT_IN_EXPR, PAYMENT_BUILT_IN_EXPR } = await import("./list-query.ts");

/**
 * F-t12-004: mirrored rows show raw "salesInvoice:<uuid>" in the INVOICE
 * column and "salesInvoicePayment:<uuid>" in the receipts PAYMENT column,
 * while the Reference column holds the human number (PS-INV103296 /
 * PAY-PS-INV). The list number expressions must fall back to the
 * reference and never render the source handle.
 */
test("list number expressions fall back to the reference on source handles", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "AR clerk", "admin"));
    const handle = `salesInvoice:${randomUUID()}`;
    const payHandle = `salesInvoicePayment:${randomUUID()}`;
    await withBypassContext(() => db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, reference_number, subsidiary_id, party_id,
         document_date, due_date, currency, subtotal, tax_total, total, created_by)
      values
        (${randomUUID()}, ${org.orgId}, 'customer_invoice', 'draft', ${handle}, 'PS-INV103296',
         ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date}, 'CAD', '100', '0', '100', ${actor}),
        (${randomUUID()}, ${org.orgId}, 'customer_payment', 'draft', ${payHandle}, 'PAY-PS-INV',
         ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date}, 'CAD', '100', '0', '100', ${actor}),
        (${randomUUID()}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-00046', 'PO-77',
         ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date}, 'CAD', '50', '0', '50', ${actor})`));
    const rows = (await withBypassContext(() => db.execute<{ invoice: string; payment: string }>(sql`
      select ${DOCUMENT_BUILT_IN_EXPR.document_number} as invoice,
             ${PAYMENT_BUILT_IN_EXPR.document_number} as payment
        from documents d
       where d.org_id = ${org.orgId}
       order by d.document_number`))).rows.map((r) => [r.invoice, r.payment] as const);
    assert.deepEqual(rows, [
      ["INV-00046", "INV-00046"],
      ["PS-INV103296", "PS-INV103296"],
      ["PAY-PS-INV", "PAY-PS-INV"],
    ]);
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
});
