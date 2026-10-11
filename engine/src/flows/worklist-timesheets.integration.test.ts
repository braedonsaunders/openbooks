import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  worklistApprovals,
  worklistApprovalsCount,
  worklistApprovalsPage,
  type WorklistPageScope,
} from "./approval-worklist.ts";
import {
  assertDedicatedFixtureDatabase,
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedFlowActors,
} from "../testing/fixtures.ts";

/**
 * Gateless submitted weeks belong to the approvals union through one
 * predicate: the rows, the paged total, and the badge count agree, and the
 * leg holds back gate-owned weeks, decided weeks, and the actor's own weeks
 * under prevent-self-approval.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;
const SCOPE: WorklistPageScope = { roles: ["approver"], allowedSubsidiaryIds: null, includeFlows: false, includeTimesheets: true };

async function seedWeek(
  orgId: string,
  subsidiaryId: string,
  submitterId: string,
  personName: string,
  weekStart: string,
): Promise<{ weekId: string; employeeId: string }> {
  const employeeId = randomUUID();
  await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${employeeId}, ${orgId}, 'person', ${personName}, ${subsidiaryId}, true, '{}'::jsonb)`);
  const weekId = randomUUID();
  await db.execute(sql`insert into timesheet_weeks (id, org_id, employee_party_id, week_start, status, submitted_at, created_by, updated_by)
    values (${weekId}, ${orgId}, ${employeeId}, ${weekStart}, 'submitted', now(), ${submitterId}, ${submitterId})`);
  return { weekId, employeeId };
}

async function countMatchesList(orgId: string, userId: string): Promise<number> {
  const count = await worklistApprovalsCount(orgId, userId, SCOPE);
  const page = await worklistApprovalsPage(orgId, userId, SCOPE, { limit: 25, offset: 0 });
  assert.equal(count, page.total, "badge count and paged total share one predicate");
  assert.equal(page.total, page.items.length, "paged total and listed rows agree");
  assert.equal(
    page.items.filter((item) => item.kind === "timesheet").length,
    page.items.length,
    "only direct weeks list with flows off",
  );
  const items = await worklistApprovals(orgId, userId, SCOPE);
  assert.equal(count, items.length, "badge count and full list share one predicate");
  return count;
}

test("gateless submitted weeks list and count through one predicate", { skip: !DB }, async () => {
  await assertDedicatedFixtureDatabase();
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await db.execute(sql`update orgs set settings = settings || '{"features": {"timeTracking": true}}'::jsonb where id = ${org.orgId}`);
    await db.execute(sql`update app_roles set permissions = '["time.approve"]'::jsonb where org_id = ${org.orgId} and key = 'approver'`);
    assert.equal(await countMatchesList(org.orgId, actors.approver1Id), 0);

    await seedWeek(org.orgId, org.subsidiaryId, actors.submitterId, "Week One", "2026-07-12");
    await seedWeek(org.orgId, org.subsidiaryId, actors.submitterId, "Week Two", "2026-07-19");
    await seedWeek(org.orgId, org.subsidiaryId, actors.submitterId, "Week Three", "2026-07-26");
    assert.equal(await countMatchesList(org.orgId, actors.approver1Id), 3);

    // A decided week leaves the union with the rows.
    await db.execute(sql`update timesheet_weeks set status = 'approved' where org_id = ${org.orgId} and week_start = '2026-07-26'`);
    assert.equal(await countMatchesList(org.orgId, actors.approver1Id), 2);

    // A gate-owned week rides its gate, never this leg.
    const { flowId } = await seedApprovalFlow(org.orgId, {
      subjectKind: "timesheet_week",
      assignees: [{ type: "user", userId: actors.approver2Id }],
      mode: "any",
    });
    const gated = await seedWeek(org.orgId, org.subsidiaryId, actors.submitterId, "Gated Week", "2026-08-02");
    const runId = randomUUID();
    await db.execute(sql`
      insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger, status)
      values (${runId}, ${org.orgId}, ${flowId}, 'timesheet_week', ${gated.weekId}, 'on_submit', 'waiting')`);
    await db.execute(sql`
      insert into flow_gates
        (id, org_id, flow_id, run_id, node_id, subject_kind, subject_id, title, group_key, quorum, status, assignee_user_id)
      values (${randomUUID()}, ${org.orgId}, ${flowId}, ${runId}, 'gate', 'timesheet_week', ${gated.weekId},
        'Gated week', ${`${runId}:gate`}, 'any', 'pending', ${actors.approver2Id})`);
    assert.equal(await countMatchesList(org.orgId, actors.approver1Id), 2);

    // The actor's own week is unactionable under prevent-self-approval.
    const own = await seedWeek(org.orgId, org.subsidiaryId, actors.approver1Id, "Own Week", "2026-08-09");
    await db.execute(sql`update users set party_id = ${own.employeeId} where id = ${actors.approver1Id}`);
    assert.equal(await countMatchesList(org.orgId, actors.approver1Id), 2);

    // Without the grant the leg stays out of the union entirely.
    assert.equal(
      await worklistApprovalsCount(org.orgId, actors.approver1Id, { ...SCOPE, includeTimesheets: false }),
      0,
      "feature-off callers count no weeks",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
