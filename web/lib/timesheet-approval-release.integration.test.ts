import { installEngineSeams } from "@openbooks/engine/composition/install";
installEngineSeams();
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  db,
  withBypassContext,
  withOrgContext,
  withOrgTransaction,
} from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
  createScratchUser,
} from "@openbooks/engine/testing/fixtures";
import { routeSubjectSubmission } from "@openbooks/engine/flows/submission-policy";
import { decideGate } from "@openbooks/engine/flows/module";
import { registerFlowApprovalReleaseHandlers } from "./flow-approval-releases.ts";
await registerFlowApprovalReleaseHandlers();

/**
 * Flow-gated timesheet decisions must leave the same decision evidence on
 * the week's own audit row that the direct routes leave: the Approvals
 * section already shows the gate comment, but without the reason in the
 * week's change set the audit cannot explain why the week moved. Approved
 * comments ride along the same way; a zero-hour declaration approves with
 * no costing and no wage demand.
 */
const WEEK = "2026-07-12";

async function seedWeek(status: "submitted", entryHours: string) {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  const submitterId = await withBypassContext(() =>
    createScratchUser(org.orgId, "Week author", "admin"),
  );
  await withBypassContext(async () => {
    await db.execute(sql`
      update app_roles set permissions = '["time.read", "time.manage", "time.approve"]'::jsonb
       where org_id = ${org.orgId} and key = 'admin'`);
    await db.execute(sql`
      update orgs set settings = settings || '{"features": {"timeTracking": true}}'::jsonb
       where id = ${org.orgId}`);
  });
  const employeeId = randomUUID();
  const headerId = randomUUID();
  const timeEntryId = randomUUID();
  const approverId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into parties
        (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values
        (${employeeId}, ${org.orgId}, 'employee', 'Release Worker',
         ${org.subsidiaryId}, true, '{}'::jsonb),
        (${approverId}, ${org.orgId}, 'employee', 'Release Approver',
         ${org.subsidiaryId}, true, '{}'::jsonb)
    `);
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id, is_active)
      values (${randomUUID()}, ${org.orgId}, ${employeeId}, true),
             (${randomUUID()}, ${org.orgId}, ${approverId}, true)
    `);
    // The decider is a second person: self-approval stays prevented.
    await db.execute(sql`
      update users set party_id = ${approverId} where id = ${actorId} and org_id = ${org.orgId}
    `);
    await db.execute(sql`
      insert into timesheet_weeks
        (id, org_id, employee_party_id, week_start, status,
         submitted_by, submitted_at, created_by, updated_by)
      values
        (${headerId}, ${org.orgId}, ${employeeId}, ${WEEK},
         ${status}, ${submitterId}, now(), ${submitterId}, ${submitterId})
    `);
    await db.execute(sql`
      insert into time_entries
        (id, org_id, employee_party_id, worked_on, hours,
         status, is_billable, costing_basis, custom, created_by, updated_by)
      values
        (${timeEntryId}, ${org.orgId}, ${employeeId}, '2026-07-15',
         ${entryHours}, ${status}, false, 'actual', '{}'::jsonb,
         ${submitterId}, ${submitterId})
    `);
  });
  await withBypassContext(() =>
    seedApprovalFlow(org.orgId, {
      subjectKind: "timesheet_week",
      mode: "any",
      assignees: [{ type: "user", userId: actorId }],
      preventSelfApproval: true,
    }),
  );
  await withOrgTransaction(org.orgId, () =>
    routeSubjectSubmission({
      orgId: org.orgId,
      actorId: submitterId,
      subjectKind: "timesheet_week",
      subjectId: headerId,
    }),
  );
  const gates = await withOrgContext(
    org.orgId,
    async () =>
      await db.execute<{ id: string }>(
        sql`
    select id from flow_gates where org_id=${org.orgId} and subject_kind='timesheet_week'
      and subject_id=${headerId} and status='pending'`,
        "objects",
      ),
  );
  assert.equal(gates.length, 1);
  return { org, actorId, employeeId, headerId, timeEntryId, gateId: gates[0]!.id };
}

async function weekAudit(orgId: string, headerId: string) {
  return withOrgContext(
    orgId,
    async () =>
      await db.execute<{ event: string; actorId: string; changes: Record<string, unknown> }>(
        sql`
      select changes->>'event' as event, actor_id as "actorId", changes
        from audit_log
       where org_id = ${orgId} and table_name = 'timesheet_weeks' and row_id = ${headerId}
       order by at, id
    `,
        "objects",
      ),
  );
}

async function cleanup(fixture: Awaited<ReturnType<typeof seedWeek>>) {
  await withBypassContext(async () => {
    await db.execute(sql`
      delete from time_entries where org_id = ${fixture.org.orgId}
    `);
  });
  await dropScratchOrg(fixture.org.orgId);
}

test("a flow-gated rejection audits the decision reason on the week", async () => {
  const fixture = await seedWeek("submitted", "4.0000");
  try {
    const decision = await decideGate({
      gateId: fixture.gateId,
      userId: fixture.actorId,
      decision: "rejected",
      comment: "Client code is wrong, please fix",
    });
    assert.equal(decision.ok, true);
    const rows = await weekAudit(fixture.org.orgId, fixture.headerId);
    assert.equal(rows.length, 1, "the release must leave exactly one audit row for the week");
    const changes = rows[0]!.changes as {
      event: string;
      before: { status: string };
      after: { status: string };
      reason: string;
    };
    assert.equal(changes.event, "rejected");
    assert.equal(changes.before.status, "submitted");
    assert.equal(changes.after.status, "rejected");
    assert.equal(changes.reason, "Client code is wrong, please fix");
    assert.equal(rows[0]!.actorId, fixture.actorId);
  } finally {
    await cleanup(fixture);
  }
});

test("a flow-gated approval records its comment and costs no zero-hour declaration", async () => {
  const fixture = await seedWeek("submitted", "0.0000");
  const journalsBefore = await withOrgContext(
    fixture.org.orgId,
    async () =>
      (
        await db.execute<{ n: string }>(
          sql`
      select count(*) as n from journal_entries where org_id = ${fixture.org.orgId}`,
          "objects",
        )
      )[0]!.n,
  );
  try {
    const decision = await decideGate({
      gateId: fixture.gateId,
      userId: fixture.actorId,
      decision: "approved",
      comment: "Leave week looks right",
    });
    assert.equal(decision.ok, true);
    const rows = await weekAudit(fixture.org.orgId, fixture.headerId);
    assert.equal(rows.length, 1, "the release must leave exactly one audit row for the week");
    const changes = rows[0]!.changes as {
      event: string;
      after: { status: string };
      reason: string;
      entryIds: string[];
    };
    assert.equal(changes.event, "approved");
    assert.equal(changes.after.status, "approved");
    assert.equal(changes.reason, "Leave week looks right");
    assert.deepEqual(changes.entryIds, [fixture.timeEntryId]);
    // No wage row covers this employee and no journals may appear: zero
    // hours approve with the week but never enter costing effects.
    const journalsAfter = await withOrgContext(
      fixture.org.orgId,
      async () =>
        (
          await db.execute<{ n: string }>(
            sql`
        select count(*) as n from journal_entries where org_id = ${fixture.org.orgId}`,
            "objects",
          )
        )[0]!.n,
    );
    assert.equal(journalsAfter, journalsBefore);
  } finally {
    await cleanup(fixture);
  }
});
