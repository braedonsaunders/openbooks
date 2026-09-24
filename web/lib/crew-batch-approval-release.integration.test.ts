import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    return next(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withOrg } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { createBatch, setBatchLines, submitBatch } = await import("@openbooks/engine/src/hrm/field-time/crew.ts");
const { releaseCrewTimeBatchApproval } = await import("./crew-batch-approval-release.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableFieldTime(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb)
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb)
      || '{"projects": true, "timeTracking": true, "fieldTime": true, "fieldTimeGeofence": true,
             "fieldTimePhoto": false, "fieldTimeKiosk": true, "fieldTimeCrewEntry": true,
             "fieldTimeEquipment": true, "fieldTimeMultiStageApproval": true, "equipment": true}'::jsonb)
     where id = ${orgId}`);
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{fieldTime}',
      '{"roundingIncrement": 15, "roundingMode": "nearest", "unpaidBreakMinutes": 30,
        "autoCloseHours": 16, "signatureRequired": false, "equipmentToleranceHours": "1.0000",
        "photoRequired": false}'::jsonb)
     where id = ${orgId}`);
}

async function seedSubmittedBatch(orgId: string, subsidiaryId: string, actor: string): Promise<string> {
  const foreman = randomUUID();
  const worker = randomUUID();
  const projectId = randomUUID();
  return withOrg(orgId, async () => {
    await db.execute(sql`insert into parties (id, org_id, kind, display_name) values (${foreman}, ${orgId}, 'person', 'Foreman'), (${worker}, ${orgId}, 'person', 'Crew Hand')`);
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom) values (${projectId}, ${orgId}, ${subsidiaryId}, 'JOB-REL', 'Release job', 'active', true, '{}'::jsonb)`);
    const batchId = await createBatch({
      orgId, actorUserId: actor, foremanPartyId: foreman,
      projectId, workedOn: "2026-09-14", canManageAll: true, allowedSubsidiaryIds: null,
    });
    await setBatchLines({
      orgId, actorUserId: actor, batchId,
      lines: [{ employeePartyId: worker, hours: "8.0000" }],
      canManageAll: true, allowedSubsidiaryIds: null,
    });
    await submitBatch({ orgId, actorUserId: actor, batchId, canManageAll: true, allowedSubsidiaryIds: null });
    return batchId;
  });
}

async function batchStatus(batchId: string): Promise<string | undefined> {
  const rows = (await db.execute<{ status: string }>(sql`select status from crew_time_batches where id = ${batchId}`)).rows;
  return rows[0]?.status;
}

test("gate approval of a crew batch advances its stage; rejection returns it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFieldTime(org.orgId);
    // The release path resolves the approver's scope on the trusted
    // runner: an unknown login resolves to an empty scope and refuses, so
    // the test approver holds an all-entity (unrestricted) grant.
    const actor = await createScratchUser(org.orgId, "Gate approver", "gate_approver");
    await db.execute(sql`update app_roles set subsidiary_restriction = '{"mode":"all"}'::jsonb where org_id = ${org.orgId} and key = 'gate_approver'`);
    const approvedId = await seedSubmittedBatch(org.orgId, org.subsidiaryId, actor);
    await withOrg(org.orgId, async () => {
      await releaseCrewTimeBatchApproval(org.orgId, actor, approvedId, "approved", null);
    });
    // No declared chain: single approval completes at approved_stage_2.
    assert.equal(await batchStatus(approvedId), "approved_stage_2");

    const rejectedId = await seedSubmittedBatch(org.orgId, org.subsidiaryId, actor);
    await withOrg(org.orgId, async () => {
      await releaseCrewTimeBatchApproval(org.orgId, actor, rejectedId, "rejected", "Split the overtime line");
    });
    assert.equal(await batchStatus(rejectedId), "rejected");
    const reason = (await db.execute<{ reason: string | null }>(sql`select reason from crew_time_batch_events where batch_id = ${rejectedId} and kind = 'rejected' order by recorded_at desc limit 1`)).rows[0]?.reason;
    assert.equal(reason, "Split the overtime line");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
