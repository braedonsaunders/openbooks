import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * Leave-covered weeks: approved leave overlapping the week surfaces on the
 * loaded week so the no-hours declaration can name it, and the declaration's
 * audit records the leave the approver must see — re-derived server-side,
 * never trusted from the client. Another employee's approved leave never
 * surfaces as cover.
 */
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __noHoursLeaveState: state });
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.endsWith("/lib/feature-gates") &&
      (context.parentURL?.includes("/api/timesheets/submit/") ||
        context.parentURL?.includes("/web/lib/api/route.ts"))
    ) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function guardFeaturePermission(){
              return {
                user: globalThis.__noHoursLeaveState.user,
                permissions: new Set(['time.manage']),
                allowedSubsidiaryIds: null,
              };
            }
          `),
      };
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { randomUUID } = await import("node:crypto");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { loadWeek } = await import("./_lib.ts");
const { POST: submitWeek } = await import("./submit/route.ts");

const WEEK = "2026-07-12";

async function seedLeaveCover() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  const employeeId = randomUUID();
  const employmentId = randomUUID();
  const leaveTypeId = randomUUID();
  const requestId = randomUUID();
  const strangerId = randomUUID();
  const strangerEmploymentId = randomUUID();
  await withBypassContext(async () => {
    for (const [party, name] of [[employeeId, "Leave Worker"], [strangerId, "Stranger"]] as const) {
      await db.execute(sql`
        insert into parties
          (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values
          (${party}, ${org.orgId}, 'employee', ${name},
           ${org.subsidiaryId}, true, '{}'::jsonb)
      `);
      await db.execute(sql`
        insert into employee_roles (id, org_id, party_id, is_active)
        values (${randomUUID()}, ${org.orgId}, ${party}, true)
      `);
    }
    await db.execute(sql`
      update users set party_id = ${employeeId} where id = ${actorId} and org_id = ${org.orgId}
    `);
    for (const [employment, party] of [[employmentId, employeeId], [strangerEmploymentId, strangerId]] as const) {
      await db.execute(sql`
        insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id)
        values (${employment}, ${org.orgId}, ${party}, ${org.subsidiaryId})
      `);
    }
    await db.execute(sql`
      insert into hrm_leave_types (id, org_id, code, name)
      values (${leaveTypeId}, ${org.orgId}, 'VAC', 'Vacation')
    `);
    // The worker's approved full-week absence, plus a stranger's overlapping
    // one that must never surface as this week's cover.
    await db.execute(sql`
      insert into hrm_leave_requests
        (id, org_id, employment_id, leave_type_id, starts_on, ends_on, hours,
         reason, status, decided_by, decided_at, decision_reason)
      values
        (${requestId}, ${org.orgId}, ${employmentId}, ${leaveTypeId},
         '2026-07-13', '2026-07-17', '40.00',
         'Family week', 'approved', ${actorId}, now(), 'Approved: coverage arranged')
    `);
    await db.execute(sql`
      insert into hrm_leave_requests
        (id, org_id, employment_id, leave_type_id, starts_on, ends_on, hours,
         reason, status, decided_by, decided_at, decision_reason)
      values
        (${randomUUID()}, ${org.orgId}, ${strangerEmploymentId}, ${leaveTypeId},
         '2026-07-14', '2026-07-16', '24.00',
         'Stranger time off', 'approved', ${actorId}, now(), 'Approved')
    `);
  });
  return { org, actorId, employeeId, requestId };
}

async function cleanup(orgId: string) {
  await dropScratchOrg(orgId);
}

test(
  "the loaded week names the approved leave covering it, and no one else's",
  async () => {
    const fixture = await seedLeaveCover();
    state.user = { orgId: fixture.org.orgId, id: fixture.actorId };
    try {
      const week = await withOrgContext(fixture.org.orgId, () =>
        loadWeek(fixture.org.orgId, fixture.employeeId, WEEK),
      );
      assert.deepEqual(week.leaveCover, [
        { requestId: fixture.requestId, leaveType: "VAC — Vacation", from: "2026-07-13", to: "2026-07-17" },
      ]);
    } finally {
      await cleanup(fixture.org.orgId);
    }
  },
);

test(
  "the no-hours declaration audits the covering leave for the approver",
  async () => {
    const fixture = await seedLeaveCover();
    state.user = { orgId: fixture.org.orgId, id: fixture.actorId };
    try {
      const res = await withOrgContext(fixture.org.orgId, () =>
        submitWeek(
          new Request("http://audit.local/api/timesheets/submit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ employee: fixture.employeeId, week: WEEK, noHours: true, reason: "On vacation all week" }),
          }),
        ),
      );
      assert.equal(res.status, 200, await res.text());
      const rows = await withOrgContext(fixture.org.orgId, async () => (
        await db.execute<{ changes: unknown }>(sql`
          select changes from audit_log
           where org_id = ${fixture.org.orgId} and table_name = 'timesheet_weeks'
             and changes->>'event' = 'no_hours_declared'
        `)
      ).rows);
      assert.equal(rows.length, 1, "the declaration leaves exactly one audit row");
      const changes = rows[0]!.changes as {
        reason: string;
        leaveRequests: { requestId: string; leaveType: string; from: string; to: string }[];
      };
      assert.equal(changes.reason, "On vacation all week");
      assert.deepEqual(changes.leaveRequests, [
        { requestId: fixture.requestId, leaveType: "VAC — Vacation", from: "2026-07-13", to: "2026-07-17" },
      ]);
    } finally {
      await cleanup(fixture.org.orgId);
    }
  },
);
