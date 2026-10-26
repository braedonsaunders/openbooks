import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  worklistApprovals,
  worklistApprovalsCount,
  worklistApprovalsPage,
} from "./approval-worklist.ts";
import { routeSubjectSubmission } from "./submission-policy.ts";
import {
  assertDedicatedFixtureDatabase,
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedFlowActors,
} from "../testing/fixtures.ts";
import { timesheetWeekAdapter } from "../inbox/adapters/timesheet-week.ts";
import { flowsApprovalAdapter } from "../inbox/adapters/flows-approval.ts";
import { installEngineSeams } from "../composition/install.ts";
installEngineSeams();
const DB = { skip: !process.env.OPENBOOKS_DB_URL };

async function week(orgId: string, subsidiaryId: string, actorId: string, weekStart: string) {
  const person = randomUUID(),
    id = randomUUID();
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
  values(${person},${orgId},'person','Crew Hand',${subsidiaryId},true,'{}'::jsonb)`);
  await db.execute(sql`insert into timesheet_weeks(id,org_id,employee_party_id,week_start,status,submitted_by,submitted_at,created_by,updated_by)
  values(${id},${orgId},${person},${weekStart},'submitted',${actorId},now(),${actorId},${actorId})`);
  return { id, person };
}

test(
  "timesheet approvals are configured gates with identical counts, paging, scope and dedicated inbox ownership",
  DB,
  async () => {
    await assertDedicatedFixtureDatabase();
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await db.execute(
        sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"timeTracking":true}'::jsonb) where id=${org.orgId}`,
      );
      const scope = { roles: ["approver"], allowedSubsidiaryIds: null };
      await week(org.orgId, org.subsidiaryId, actors.submitterId, "2026-07-12");
      assert.equal(
        await worklistApprovalsCount(org.orgId, actors.approver1Id, scope),
        0,
        "a submitted status alone grants no alternate approval path",
      );
      for (let i = 0; i < 2; i++)
        await seedApprovalFlow(org.orgId, {
          subjectKind: "timesheet_week",
          assignees: [{ type: "user", userId: actors.approver1Id }],
          mode: "all",
        });
      const submitted = await week(org.orgId, org.subsidiaryId, actors.submitterId, "2026-07-19");
      const routing = await withOrgTransaction(org.orgId, () =>
        routeSubjectSubmission({
          orgId: org.orgId,
          actorId: actors.submitterId,
          subjectKind: "timesheet_week",
          subjectId: submitted.id,
        }),
      );
      assert.equal(routing.policy.kind, "gated");
      const items = await worklistApprovals(org.orgId, actors.approver1Id, scope);
      assert.equal(items.length, 2);
      assert.ok(items.every((item) => item.gate.subjectId === submitted.id));
      const page = await worklistApprovalsPage(org.orgId, actors.approver1Id, scope, {
        limit: 1,
        offset: 1,
      });
      assert.equal(page.total, 2);
      assert.equal(page.items.length, 1);
      assert.notEqual(page.items[0]!.id, items[0]!.id);
      assert.equal(await worklistApprovalsCount(org.orgId, actors.approver1Id, scope), 2);
      assert.equal(
        await worklistApprovalsCount(org.orgId, actors.approver1Id, {
          ...scope,
          includeFlows: false,
        }),
        0,
      );
      assert.equal(
        await worklistApprovalsCount(org.orgId, actors.approver1Id, {
          ...scope,
          allowedSubsidiaryIds: new Set<string>(),
        }),
        0,
      );
      assert.equal(
        await worklistApprovalsCount(org.orgId, actors.approver2Id, scope),
        0,
        "a native permission does not create a gate assignment",
      );
      const ctx = {
        orgId: org.orgId,
        actorId: actors.approver1Id,
        asOf: "2026-07-26",
        scope,
      };
      const inbox = await timesheetWeekAdapter.list(ctx);
      assert.equal(inbox.length, 2);
      assert.ok(inbox.every((item) => item.source.kind === "timesheet_week_gate"));
      assert.ok(inbox.every((item) => item.actions.some((action) => action.key === "approve")));
      assert.deepEqual(
        await flowsApprovalAdapter.list(ctx),
        [],
        "dedicated timesheet gates do not duplicate in the generic inbox",
      );
      const centralized = { ...ctx, approvalWorklistOwnsGates: true };
      assert.deepEqual(
        await timesheetWeekAdapter.list(centralized),
        [],
        "the approval worklist owns the gate instead of duplicating it as a task",
      );
      assert.equal((await flowsApprovalAdapter.list(centralized)).length, 2);
      assert.equal(await flowsApprovalAdapter.count!(centralized), 2);
      await db.execute(
        sql`update flow_runs set status='cancelled' where org_id=${org.orgId} and subject_id=${submitted.id}`,
      );
      assert.equal(
        await worklistApprovalsCount(org.orgId, actors.approver1Id, scope),
        0,
        "cancelled routing is not actionable",
      );
      assert.deepEqual(await timesheetWeekAdapter.list(ctx), []);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
