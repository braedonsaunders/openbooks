/**
 * Vendor pay-application optimistic concurrency — DB integration.
 *
 * Two editors read the same draft (revision 1). The first save lands and
 * bumps the token; the second save with the stale token refuses with a
 * conflict naming the remedy, and the loser's inputs never overwrite the
 * winner's certified lines. Reloading the current token saves cleanly.
 *
 * Integration partition: skips without OPENBOOKS_DB_URL; run one file per
 * database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";
import {
  addSubcontractSovLine,
  createVendorPayApplication,
  SubcontractConflictError,
  updateVendorPayApplicationLines,
} from "./subcontracts.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function setupDraft(): Promise<{
  orgId: string;
  actor: string;
  other: string;
  appId: string;
  sov: string;
}> {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "Revision editor", "admin");
  const other = await createScratchUser(org.orgId, "Revision rival", "admin");
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"subcontracts":true}'::jsonb) where id=${org.orgId}`);
  const profile = BUILTIN_PROJECT_TYPES.find((p) => p.key === "schedule_of_values")!;
  const type = randomUUID();
  const project = randomUUID();
  const subcontract = randomUUID();
  await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
    values(${type},${org.orgId},'payapp_revision_test','Payapp revision test','fixed_price',${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`);
  await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
    values(${org.orgId},${type},'2000-01-01',${JSON.stringify(profile.financialProfile)}::jsonb,'Payapp revision test policy')`);
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status)
    values(${project},${org.orgId},${org.subsidiaryId},'REV','Revision job',${org.customerId},${type},'active')`);
  await db.execute(sql`insert into vendor_roles(org_id,party_id) values(${org.orgId},${org.vendorId})`);
  await db.execute(sql`insert into subcontracts(id,org_id,project_id,vendor_id,number,title,currency,original_commitment,default_retainage_percent,status)
    values(${subcontract},${org.orgId},${project},${org.vendorId},'SC-REV','Revision scope','CAD','5000','0','draft')`);
  const sov = (await withOrgTransaction(org.orgId, () => addSubcontractSovLine({
    orgId: org.orgId, userId: actor, subcontractId: subcontract,
    description: "Work", scheduledValue: "2000", sortOrder: 1,
  }))).id;
  await db.execute(sql`update subcontracts set status = 'active' where org_id = ${org.orgId} and id = ${subcontract}`);
  const app = await withOrgTransaction(org.orgId, () => createVendorPayApplication({
    orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: org.date,
  }));
  return { orgId: org.orgId, actor, other, appId: app.id, sov };
}

async function revisionOf(orgId: string, appId: string): Promise<number> {
  const row = (await db.execute<{ revision: number }>(sql`
    select revision from vendor_pay_applications where org_id = ${orgId} and id = ${appId}
  `)).rows[0];
  return Number(row!.revision);
}

async function workOf(orgId: string, appId: string, sov: string): Promise<string> {
  const row = (await db.execute<{ work: string }>(sql`
    select work_completed_this_period::text as work from vendor_pay_application_lines
     where org_id = ${orgId} and pay_application_id = ${appId} and sov_line_id = ${sov}
  `)).rows[0];
  return row!.work;
}

test("a stale revision refuses with 409 evidence and never overwrites the winner", { skip: !DB }, async () => {
  const f = await setupDraft();
  try {
    assert.equal(await revisionOf(f.orgId, f.appId), 1, "a new draft starts at revision 1");

    // First editor saves with the token they read: lands, bumps to 2.
    const first = await withOrgTransaction(f.orgId, () => updateVendorPayApplicationLines({
      orgId: f.orgId, userId: f.actor, payApplicationId: f.appId, expectedRevision: 1,
      lines: [{ sovLineId: f.sov, workCompletedThisPeriod: "1000", materialsStoredCurrent: "0" }],
    }));
    assert.equal(first.revision, 2, "the save returns the bumped token for chaining");
    assert.equal(await revisionOf(f.orgId, f.appId), 2);

    // Second editor still holds 1: refuses naming the remedy.
    await assert.rejects(
      withOrgTransaction(f.orgId, () => updateVendorPayApplicationLines({
        orgId: f.orgId, userId: f.other, payApplicationId: f.appId, expectedRevision: 1,
        lines: [{ sovLineId: f.sov, workCompletedThisPeriod: "5", materialsStoredCurrent: "0" }],
      })),
      (error: unknown) => {
        assert.ok(error instanceof SubcontractConflictError, "a stale token is a conflict, not a validation refusal");
        assert.match((error as Error).message, /changed while you were editing/);
        assert.match((error as Error).message, /reload/);
        return true;
      },
    );
    assert.equal(
      await workOf(f.orgId, f.appId, f.sov),
      "1000.0000",
      "the loser's inputs never overwrite the winner's certified lines",
    );

    // Reloaded (2), the second editor saves cleanly.
    const second = await withOrgTransaction(f.orgId, () => updateVendorPayApplicationLines({
      orgId: f.orgId, userId: f.other, payApplicationId: f.appId, expectedRevision: 2,
      lines: [{ sovLineId: f.sov, workCompletedThisPeriod: "1200", materialsStoredCurrent: "0" }],
    }));
    assert.equal(second.revision, 3);
    assert.equal(await workOf(f.orgId, f.appId, f.sov), "1200.0000");
  } finally {
    await dropScratchOrgReporting(f.orgId);
  }
});
