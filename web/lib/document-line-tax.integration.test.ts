import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";

// Tax evidence written through the document editor's write path (the same
// createDocumentDraft + applyDocumentEdit core the drawer uses) must carry
// the same attribution and effective-dated rates the engine posts from.
stubModules({ intl: true, navigation: false, authz: false, features: false });

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { saveMarketplaceFacilitator } = await import("@openbooks/engine/src/tax/marketplace-facilitators.ts");
const { API_RECORD_TYPES, toResolved } = await import("./api/registry-data.ts");
const { createRecord, updateRecord } = await import("./api/writers.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;
const invoices = toResolved(API_RECORD_TYPES.find((t) => t.key === "invoices")!);

async function fixture() {
  const seeded = await withBypassContext(async () => {
    const org = await createScratchOrg();
    const actor = await createScratchUser(org.orgId, "Invoice keeper", "admin");
    const taxCode = randomUUID();
    await db.execute(sql`insert into tax_codes(id,org_id,code,name,applies_to,is_active,collected_account_id,paid_account_id)
      values(${taxCode},${org.orgId},'LINE-TAX','Line tax','sales',true,${org.accounts.taxOutput},${org.accounts.taxInput})`);
    return { org, actor, taxCode };
  });
  const user = {
    id: seeded.actor,
    email: "invoice-keeper@scratch.test",
    name: "Invoice keeper",
    roles: [{ key: "admin", name: "Admin" }],
    orgId: seeded.org.orgId,
    envKind: "production" as const,
    productionOrgId: seeded.org.orgId,
    isSuperAdmin: false,
    homeUserId: seeded.actor,
    homeOrgId: seeded.org.orgId,
  };
  return { ...seeded, user };
}

const createdId = (body: unknown): string => (body as { doc: { id: string } }).doc.id;

test("a marketplace line saved through the editor books facilitator-collected tax", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    await withBypassContext(async () => {
      await db.execute(sql`insert into tax_rates(org_id,tax_code_id,rate_percent,effective_from)
        values(${f.org.orgId},${f.taxCode},'10','2020-01-01')`);
      const clearingId = randomUUID();
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                              reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${clearingId}, ${f.org.orgId}, '1150', 'Marketplace Clearing', 'asset_receivable',
                false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
      await saveMarketplaceFacilitator(db, f.org.orgId, {
        name: "Amazon", clearingAccountId: clearingId, collectionMode: "gross", states: ["WA"],
      }, f.actor);
    });
    const result = await withOrgContext(f.org.orgId, () => createRecord(f.user, invoices, [], {
      partyId: f.org.customerId,
      documentDate: f.org.date,
      lines: [{ accountId: f.org.accounts.revenue, amount: "200.0000", taxCodeId: f.taxCode, marketplaceFacilitator: "Amazon" }],
    }, { source: "api", allowedSubsidiaryIds: null }));
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const evidence = (await withOrgContext(f.org.orgId, () => db.execute<{ collectedBy: string; facilitatorName: string | null; taxAmount: string }>(sql`
      select c.collected_by as "collectedBy", c.facilitator_name as "facilitatorName", c.tax_amount::text as "taxAmount"
        from document_line_tax_components c
        join document_lines dl on dl.id = c.document_line_id and dl.org_id = c.org_id
       where dl.document_id = ${createdId(result.body)} and dl.org_id = ${f.org.orgId}`))).rows;
    // Before the editor delegated to the engine writer, collected_by fell to
    // its 'merchant' default and the facilitator's tax posted as ours.
    assert.deepEqual(evidence, [{ collectedBy: "marketplace", facilitatorName: "Amazon", taxAmount: "20.0000" }]);
  } finally {
    await withBypassContext(() => dropScratchOrg(f.org.orgId));
  }
});

test("moving a draft's date across a rate change refuses a header-only save", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    await withBypassContext(() => db.execute(sql`insert into tax_rates(org_id,tax_code_id,rate_percent,effective_from,effective_to)
      values(${f.org.orgId},${f.taxCode},'5','2020-01-01','2026-07-31'),(${f.org.orgId},${f.taxCode},'6','2026-08-01',null)`));
    const line = { accountId: f.org.accounts.revenue, amount: "1000.0000", taxCodeId: f.taxCode };
    const created = await withOrgContext(f.org.orgId, () => createRecord(f.user, invoices, [], {
      partyId: f.org.customerId, documentDate: f.org.date, lines: [line],
    }, { source: "api", allowedSubsidiaryIds: null }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = createdId(created.body);
    const taxTotal = async () => (await withOrgContext(f.org.orgId, () => db.execute<{ t: string }>(sql`
      select tax_total::text as t from documents where id = ${id} and org_id = ${f.org.orgId}`))).rows[0]!.t;
    assert.equal(await taxTotal(), "50.0000");
    // The stored 5% would otherwise post on an August date where 6% applies.
    const headerOnly = await withOrgContext(f.org.orgId, () => updateRecord(f.user, invoices, [], id, { documentDate: "2026-08-15" }, { source: "api", allowedSubsidiaryIds: null }));
    assert.equal(headerOnly.status, 422);
    assert.match(JSON.stringify(headerOnly.body), /Line 1 carries LINE-TAX at 5\.0000%, but 6\.0000% is in effect on 2026-08-15/);
    assert.equal(await taxTotal(), "50.0000");
    const withLines = await withOrgContext(f.org.orgId, () => updateRecord(f.user, invoices, [], id, { documentDate: "2026-08-15", lines: [line] }, { source: "api", allowedSubsidiaryIds: null }));
    assert.ok(withLines.status < 300, JSON.stringify(withLines.body));
    assert.equal(await taxTotal(), "60.0000");
  } finally {
    await withBypassContext(() => dropScratchOrg(f.org.orgId));
  }
});
