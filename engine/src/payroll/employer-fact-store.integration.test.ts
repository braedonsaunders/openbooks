import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";
import { resolveStoredEmployerFact, upsertPayrollEmployerFact } from "./employer-fact-store.ts";
import "./packs.ts";

test("employer fact storage resolves legal-employer history and retains audited corrections", async () => {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const tag = randomUUID();
  try {
    await db.execute(sql`update subsidiaries set country = 'FR'
      where org_id = ${org.orgId} and id = ${org.subsidiaryId}`);
    const input = {
      orgId: org.orgId,
      actorId,
      subsidiaryId: org.subsidiaryId,
      country: "FR",
      factKey: "effectif_moyen_annuel",
      effectiveFrom: "2024-01-01",
      changeReason: `Annual legal-employer headcount correction ${tag}`,
    };
    await upsertPayrollEmployerFact({ ...input, value: "12.34" });
    assert.equal(await resolveStoredEmployerFact({
      tx: db, orgId: org.orgId, subsidiaryId: org.subsidiaryId,
      country: "FR", factKey: input.factKey, asOf: "2024-06-30",
    }), "12.34");

    await upsertPayrollEmployerFact({
      ...input, value: "14.56", changeReason: `Corrected from filed prior-year roster ${tag}`,
    });
    assert.equal(await resolveStoredEmployerFact({
      tx: db, orgId: org.orgId, subsidiaryId: org.subsidiaryId,
      country: "FR", factKey: input.factKey, asOf: "2024-06-30",
    }), "12.34", "a correction today must not reinterpret a historical payroll date");
    assert.equal(await resolveStoredEmployerFact({
      tx: db, orgId: org.orgId, subsidiaryId: org.subsidiaryId,
      country: "FR", factKey: input.factKey, asOf: new Date().toISOString().slice(0, 10),
    }), "14.56");

    const audit = await db.execute<{ action: string; changes: { reason?: string } }>(sql`
      select action, changes
        from audit_log
       where org_id = ${org.orgId}
         and table_name = 'payroll_employer_facts'
         and changes->>'factKey' = ${input.factKey}
         and changes->>'reason' like ${`%${tag}%`}
       order by at, id
    `);
    assert.deepEqual(audit.rows.map((row) => row.action), ["insert", "supersede", "insert"]);
    assert.equal(audit.rows[2]?.changes.reason, `Corrected from filed prior-year roster ${tag}`);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
