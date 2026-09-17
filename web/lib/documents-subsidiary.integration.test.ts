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
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { applyDocumentEdit, DocumentEditError, loadDocumentEditCurrent } = await import("./documents.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

test("applyDocumentEdit refuses to clear a document's subsidiary", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { actor, id } = await withBypassContext(async () => {
      const actor = await createScratchUser(org.orgId, "Subsidiary keeper", "subsidiary_keeper");
      const id = randomUUID();
      await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,created_by)
        values (${id},${org.orgId},'vendor_bill','draft','NULL-SUB-1',${org.subsidiaryId},${org.vendorId},${org.date},'CAD','0','0','0',${actor})`);
      return { actor, id };
    });
    // The edit service and its readers issue bare queries with explicit org
    // predicates, which pooled RLS denies outside an explicit scope (reads see
    // zero rows) once ./documents.ts pulls in the web request-org resolver.
    const current = await withOrgContext(org.orgId, () => loadDocumentEditCurrent(id, org.orgId));
    assert.ok(current);
    await assert.rejects(
      withOrgContext(org.orgId, () => applyDocumentEdit(
        id,
        current,
        { subsidiaryId: null, expectedUpdatedAt: current.updatedAt },
        { orgId: org.orgId, userId: actor, source: "api" },
      )),
      (error: unknown) => error instanceof DocumentEditError && error.status === 422,
    );
    const after = await withOrgContext(org.orgId, async () => (await db.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from documents where id = ${id} and org_id = ${org.orgId}`)));
    assert.equal(after.rows[0]?.subsidiary_id, org.subsidiaryId);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("applyDocumentEdit validates partial header custom fields against the stored bag", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { actor, id } = await withBypassContext(async () => {
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
      return { actor, id };
    });
    const current = await withOrgContext(org.orgId, () => loadDocumentEditCurrent(id, org.orgId));
    assert.ok(current);
    await withOrgContext(org.orgId, () => applyDocumentEdit(
      id,
      current,
      { custom: { optional_note: "updated" }, expectedUpdatedAt: current.updatedAt },
      { orgId: org.orgId, userId: actor, source: "api" },
    ));
    const after = await withOrgContext(org.orgId, async () => await db.execute<{ custom: Record<string, unknown> }>(sql`
      select custom from documents where id = ${id} and org_id = ${org.orgId}
    `));
    assert.deepEqual(after.rows[0]?.custom, { required_code: "R-1", optional_note: "updated" });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("applyDocumentEdit refuses line accounts from another organization", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const foreign = await withBypassContext(() => createScratchOrg());
  try {
    const { actor, id } = await withBypassContext(async () => {
      const actor = await createScratchUser(org.orgId, "Line account keeper", "line_account_keeper");
      const id = randomUUID();
      await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,created_by)
        values (${id},${org.orgId},'vendor_bill','draft','FOREIGN-ACCT-1',${org.subsidiaryId},${org.vendorId},${org.date},'CAD','0','0','0',${actor})`);
      return { actor, id };
    });
    // A foreign UUID passes the global document_lines FK, so the service
    // itself must refuse it: otherwise the tenant-coherent lines FK kills
    // the save at the insert as an unhandled 500 deep in the transaction.
    // This probe deliberately reads across orgs, so it stays under bypass —
    // the scratch org's own scope would deny it to zero rows.
    const foreignAccount = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`
      select id from accounts where org_id = ${foreign.orgId} and is_active and not is_summary limit 1`)).rows[0]!.id);
    const current = await withOrgContext(org.orgId, () => loadDocumentEditCurrent(id, org.orgId));
    assert.ok(current);
    await assert.rejects(
      withOrgContext(org.orgId, () => applyDocumentEdit(
        id,
        current,
        { lines: [{ accountId: foreignAccount, amount: "10", description: "foreign account" }], expectedUpdatedAt: current.updatedAt },
        { orgId: org.orgId, userId: actor, source: "api" },
      )),
      (error: unknown) => error instanceof DocumentEditError && error.status === 404,
    );
    const lines = await withOrgContext(org.orgId, async () => await db.execute<{ n: number }>(sql`
      select count(*)::int as n from document_lines where document_id = ${id} and org_id = ${org.orgId}`));
    assert.equal(lines.rows[0]?.n, 0, "the refused save stores no foreign-account line");
    // An own-org postable account still saves.
    const reloaded = await withOrgContext(org.orgId, () => loadDocumentEditCurrent(id, org.orgId));
    assert.ok(reloaded);
    await withOrgContext(org.orgId, () => applyDocumentEdit(
      id,
      reloaded,
      { lines: [{ accountId: org.accounts.cogs, amount: "10", description: "home account" }], expectedUpdatedAt: reloaded.updatedAt },
      { orgId: org.orgId, userId: actor, source: "api" },
    ));
    const stored = await withOrgContext(org.orgId, async () => await db.execute<{ account_id: string }>(sql`
      select account_id from document_lines where document_id = ${id} and org_id = ${org.orgId}`));
    assert.equal(stored.rows[0]?.account_id, org.accounts.cogs);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
    await withBypassContext(() => dropScratchOrg(foreign.orgId));
  }
});
