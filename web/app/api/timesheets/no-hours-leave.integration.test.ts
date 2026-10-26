import { installEngineSeams } from "@openbooks/engine/composition/install";
installEngineSeams();
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
    // The route authorizes through the time workspace, which imports its
    // gate relatively ('./feature-gates'), not only through the "@/lib/…"
    // spelling the route factory uses — stub both spellings or the real
    // session gate loads and the declaration submit cannot be reached.
    if (
      (specifier.endsWith("/lib/feature-gates") &&
        (context.parentURL?.includes("/api/timesheets/submit/") ||
          context.parentURL?.includes("/web/lib/api/route.ts"))) ||
      (specifier === "./feature-gates" && context.parentURL?.endsWith("/web/lib/time-workspace.ts"))
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
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { randomUUID } = await import("node:crypto");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");
const { seedEmployment, setFeatures } = await import("@openbooks/engine/testing/hrm-harness");
const { createLeavePolicy, fileLeaveRequest, submitLeaveRequest } =
  await import("@openbooks/engine/hrm/leave");
const { loadWeek } = await import("./_lib.ts");
const { POST: submitWeek } = await import("./submit/route.ts");

const WEEK = "2026-07-12";

async function seedLeaveCover() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  // The shared time authority lock runs for real: the actor holds time.manage.
  await withBypassContext(async () => {
    await db.execute(sql`
      update app_roles set permissions = '["time.read", "time.manage", "hrm.leave.manage", "hrm.leave.request"]'::jsonb
       where org_id = ${org.orgId} and key = 'admin'`);
  });
  const employeeId = randomUUID();
  let employmentId = "";
  const leaveTypeId = randomUUID();
  let requestId = "";
  const strangerId = randomUUID();
  let strangerEmploymentId = "";
  await withBypassContext(async () => {
    for (const [party, name] of [
      [employeeId, "Leave Worker"],
      [strangerId, "Stranger"],
    ] as const) {
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
    ({ employmentId } = await seedEmployment(org.orgId, org.subsidiaryId, {
      workerPartyId: employeeId,
    }));
    ({ employmentId: strangerEmploymentId } = await seedEmployment(org.orgId, org.subsidiaryId, {
      workerPartyId: strangerId,
    }));
    await setFeatures(org.orgId, { hrm: true });
    await db.execute(sql`
      insert into hrm_leave_types (id, org_id, code, name)
      values (${leaveTypeId}, ${org.orgId}, 'VAC', 'Vacation')
    `);
  });
  await withOrgContext(org.orgId, async () => {
    await createLeavePolicy({
      orgId: org.orgId,
      actorId,
      leaveTypeId,
      accrualRule: { kind: "unlimited" },
      effectiveFrom: "2020-01-01",
    });
    for (const [employment, startsOn, endsOn, hours] of [
      [employmentId, "2026-07-13", "2026-07-17", "40"],
      [strangerEmploymentId, "2026-07-14", "2026-07-16", "24"],
    ]) {
      const draft = await fileLeaveRequest({
        orgId: org.orgId,
        actorId,
        employmentId: employment!,
        leaveTypeId,
        startsOn,
        endsOn,
        hours,
        onBehalf: true,
        reason: "Scheduled vacation",
      });
      const approved = await submitLeaveRequest({ orgId: org.orgId, actorId, requestId: draft.id });
      assert.equal(approved.status, "approved");
      if (employment === employmentId) requestId = approved.id;
    }
  });
  return { org, actorId, employeeId, requestId };
}

async function cleanup(orgId: string) {
  await dropScratchOrg(orgId);
}

test("the loaded week names the approved leave covering it, and no one else's", async () => {
  const fixture = await seedLeaveCover();
  state.user = { orgId: fixture.org.orgId, id: fixture.actorId };
  try {
    const week = await withOrgContext(fixture.org.orgId, () =>
      loadWeek(fixture.org.orgId, fixture.employeeId, WEEK),
    );
    assert.deepEqual(week.leaveCover, [
      {
        requestId: fixture.requestId,
        leaveType: "VAC — Vacation",
        from: "2026-07-13",
        to: "2026-07-17",
      },
    ]);
  } finally {
    await cleanup(fixture.org.orgId);
  }
});

test("the no-hours declaration audits the covering leave for the approver", async () => {
  const fixture = await seedLeaveCover();
  state.user = { orgId: fixture.org.orgId, id: fixture.actorId };
  try {
    const res = await withOrgContext(fixture.org.orgId, () =>
      submitWeek(
        new Request("http://audit.local/api/timesheets/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            employee: fixture.employeeId,
            week: WEEK,
            noHours: true,
            reason: "On vacation all week",
          }),
        }),
      ),
    );
    assert.equal(res.status, 200, await res.text());
    const rows = await withOrgContext(
      fixture.org.orgId,
      async () =>
        await db.execute<{ changes: unknown }>(
          sql`
          select changes from audit_log
           where org_id = ${fixture.org.orgId} and table_name = 'timesheet_weeks'
             and changes->>'event' = 'no_hours_declared'
        `,
          "objects",
        ),
    );
    assert.equal(rows.length, 1, "the declaration leaves exactly one audit row");
    const changes = rows[0]!.changes as {
      reason: string;
      leaveRequests: { requestId: string; leaveType: string; from: string; to: string }[];
    };
    assert.equal(changes.reason, "On vacation all week");
    assert.deepEqual(changes.leaveRequests, [
      {
        requestId: fixture.requestId,
        leaveType: "VAC — Vacation",
        from: "2026-07-13",
        to: "2026-07-17",
      },
    ]);
  } finally {
    await cleanup(fixture.org.orgId);
  }
});
