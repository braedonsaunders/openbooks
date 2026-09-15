import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// Live-Postgres regression: document_lines.unit_price is numeric(28,8), so a
// saved invoice line reads back at storage scale ('200.00000000'). The shared
// document edit service (web/lib/documents.ts applyDocumentEdit, used by the
// invoice/credit/bill drawers and the REST API) validated unitPrice with the
// 4dp ledger helper, so re-saving the stored values — exactly what the
// DocumentDrawer sends on every reload-then-save — failed with a 422
// ('unit price is not a valid amount') instead of round-tripping. Input
// validation must accept the column's own scale.

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { applyDocumentEdit, loadDocumentEditCurrent } = await import("./documents.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

test("applyDocumentEdit round-trips a stored 8dp unit price", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Line scale keeper", "line_scale_keeper");
    const id = randomUUID();
    await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,created_by)
      values (${id},${org.orgId},'customer_invoice','draft','SCALE-INV-1',${org.subsidiaryId},${org.customerId},${org.date},'CAD','0','0','0',${actor})`);
    const first = await loadDocumentEditCurrent(id, org.orgId);
    assert.ok(first);
    await applyDocumentEdit(
      id,
      first,
      {
        expectedUpdatedAt: first.updatedAt,
        lines: [{ accountId: org.accounts.revenue, quantity: "2", unitPrice: "200.00", amount: "400.00" }],
      },
      { orgId: org.orgId, userId: actor, source: "api" },
    );
    const stored = (await db.execute<{ quantity: string; unit_price: string }>(sql`
      select quantity::text, unit_price::text from document_lines
       where document_id = ${id} and org_id = ${org.orgId}`)).rows[0]!;
    // Premise: storage pads to the column scale.
    assert.equal(stored.unit_price, "200.00000000");
    // The drawer sends back exactly what it read; that must save.
    const second = await loadDocumentEditCurrent(id, org.orgId);
    assert.ok(second);
    await applyDocumentEdit(
      id,
      second,
      {
        expectedUpdatedAt: second.updatedAt,
        lines: [{ accountId: org.accounts.revenue, quantity: stored.quantity, unitPrice: stored.unit_price, amount: "400.00" }],
      },
      { orgId: org.orgId, userId: actor, source: "api" },
    );
    const doc = (await db.execute<{ subtotal: string; total: string }>(sql`
      select subtotal::text, total::text from documents where id = ${id} and org_id = ${org.orgId}`)).rows[0]!;
    assert.equal(doc.subtotal, "400.0000");
    assert.equal(doc.total, "400.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
