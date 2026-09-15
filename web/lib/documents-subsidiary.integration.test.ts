import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// A document's subsidiary is structural: posting falls back to the root
// entity when it is null, but every subsidiary-scoped list excludes null, so
// clearing it hides a live document from restricted readers while its ledger
// entries remain. The drawer sends `subsidiaryId: null` when its entity
// picker is empty, and the service boundary must refuse that shape the same
// way it refuses clearing a required party.
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
const { applyDocumentEdit, DocumentEditError, loadDocumentEditCurrent } = await import("./documents.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

test("applyDocumentEdit refuses to clear a document's subsidiary", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Subsidiary keeper", "subsidiary_keeper");
    const id = randomUUID();
    await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,created_by)
      values (${id},${org.orgId},'vendor_bill','draft','NULL-SUB-1',${org.subsidiaryId},${org.vendorId},${org.date},'CAD','0','0','0',${actor})`);
    const current = await loadDocumentEditCurrent(id, org.orgId);
    assert.ok(current);
    await assert.rejects(
      applyDocumentEdit(
        id,
        current,
        { subsidiaryId: null, expectedUpdatedAt: current.updatedAt },
        { orgId: org.orgId, userId: actor, source: "api" },
      ),
      (error: unknown) => error instanceof DocumentEditError && error.status === 422,
    );
    const after = (await db.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from documents where id = ${id} and org_id = ${org.orgId}`));
    assert.equal(after.rows[0]?.subsidiary_id, org.subsidiaryId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("applyDocumentEdit validates partial header custom fields against the stored bag", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Document custom keeper", "document_custom_keeper");
    const id = randomUUID();
    await db.execute(sql`
      insert into custom_field_defs
        (id, org_id, target_table, target_kind, key, label, field_type, config, is_required, is_active, created_by, updated_by)
      values
        (${randomUUID()}, ${org.orgId}, 'documents', 'vendor_bill', 'required_code', 'Required code', 'text', '{}'::jsonb, true, true, ${actor}, ${actor}),
        (${randomUUID()}, ${org.orgId}, 'documents', 'vendor_bill', 'optional_note', 'Optional note', 'text', '{}'::jsonb, false, true, ${actor}, ${actor})
    `);
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
         currency, subtotal, tax_total, total, custom, created_by)
      values
        (${id}, ${org.orgId}, 'vendor_bill', 'draft', 'CUSTOM-PATCH-1', ${org.subsidiaryId},
         ${org.vendorId}, ${org.date}, 'CAD', '0', '0', '0',
         '{"required_code":"R-1"}'::jsonb, ${actor})
    `);
    const current = await loadDocumentEditCurrent(id, org.orgId);
    assert.ok(current);
    await applyDocumentEdit(
      id,
      current,
      { custom: { optional_note: "updated" }, expectedUpdatedAt: current.updatedAt },
      { orgId: org.orgId, userId: actor, source: "api" },
    );
    const after = await db.execute<{ custom: Record<string, unknown> }>(sql`
      select custom from documents where id = ${id} and org_id = ${org.orgId}
    `);
    assert.deepEqual(after.rows[0]?.custom, { required_code: "R-1", optional_note: "updated" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
