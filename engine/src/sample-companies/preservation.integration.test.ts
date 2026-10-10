import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, seedDraftDocument } from "../testing/fixtures.ts";
import { recordSupplyEvidence } from "../tax/cross-border-records.ts";
import { assertSampleRecordsPreserved, snapshotSampleRecords } from "./preservation.ts";

test("sample preservation retains every native composite-key evidence row and refuses changes atomically", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Supply evidence author", "admin"));
    await withBypass(() => db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"crossBorderTax":true}'::jsonb) where id=${org.orgId}`));
    const documentId = await withBypass(() => seedDraftDocument(org.orgId, { kind: "customer_invoice", createdBy: actorId }));
    const election = { supplyKind: "digital_service" as const, customerKind: "consumer" as const };
    const evidence = [
      { kind: "billing_address" as const, country: "CA", source: "customer-portal" },
      { kind: "billing_address" as const, country: "CA", source: "order-review" },
    ];
    await withOrgTransaction(org.orgId, async () => {
      await recordSupplyEvidence(db, org.orgId, documentId, { election, evidence }, actorId);
      // A fixture lookup hint must never replace the schema's actual identity.
      const before = await snapshotSampleRecords(org.orgId, new Map([["document_supply_evidence", "id"]]));
      const composite = before.get("document_supply_evidence")!;
      assert.deepEqual(composite.primaryKeys, ["org_id", "document_id", "kind", "source"]);
      assert.equal(composite.rows.length, 2);
      assert.equal(new Set(composite.rows.map(row => row.id)).size, 2);
      const addedId = await seedDraftDocument(org.orgId, { kind: "customer_invoice", createdBy: actorId });
      await recordSupplyEvidence(db, org.orgId, addedId, { election, evidence: [evidence[0]!] }, actorId);
      assert.ok((await assertSampleRecordsPreserved(org.orgId, before)).records >= 2, "new native records do not alter the protected rows");
    });
    const readEvidence = () => withOrgTransaction(org.orgId, async () => (await db.execute(sql`
      select to_jsonb(e) as evidence from document_supply_evidence e where org_id=${org.orgId} order by document_id,kind,source`)).rows, { readOnly: true });
    const before = await readEvidence();
    await assert.rejects(withOrgTransaction(org.orgId, async () => {
      const all = await snapshotSampleRecords(org.orgId, new Map());
      const protectedEvidence = new Map([["document_supply_evidence", all.get("document_supply_evidence")!]]);
      await recordSupplyEvidence(db, org.orgId, documentId, { election, evidence: [{ ...evidence[0]!, country: "US" }, evidence[1]!] }, actorId);
      await assertSampleRecordsPreserved(org.orgId, protectedEvidence);
    }), /change existing document_supply_evidence record/);
    assert.deepEqual(await readEvidence(), before, "a changed composite-key row rolls back the complete native transaction");
  } finally { await withBypass(() => dropScratchOrg(org.orgId)); }
});
