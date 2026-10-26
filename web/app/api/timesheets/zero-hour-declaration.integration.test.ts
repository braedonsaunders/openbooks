import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import type { SessionUser } from "../../../lib/auth";

/**
 * Zero-hour week declarations: a grid row carrying a memo but no hours is an
 * explicit "no hours worked" declaration (leave, no work), not an empty line.
 * The weekly save persists it as one zero-hour entry on the week's Sunday so
 * the declaration survives a reload, reads back with its memo, and submits
 * like any draft line — instead of being silently discarded with a success
 * toast. The declaration names no time type: it declares against the week's
 * approved leave, which the declaration audit records for the approver.
 */
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __zeroHourDeclaration: session });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next-intl/server")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}",
      };
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts"))
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__zeroHourDeclaration.user}",
      };
    return next(specifier, context);
  },
});
const { configureTimesheetReviewFixture, decideTimesheetFixture } =
  await import("../../../testing/timesheet-flows");
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { PUT } = await import("./route");
const { POST: submitWeek } = await import("./submit/route");

const { loadWeek } = await import("./_lib");

const WEEK = "2026-08-02";
const MEMO = "Family vacation Aug 2–8 — no hours worked";

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() =>
    createScratchUser(org.orgId, "Declaration auditor", "reviewer"),
  );
  await withBypassContext(async () => {
    await db.execute(
      sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`,
    );
    await db.execute(
      sql`update orgs set settings = settings || '{"features": {"projects": true, "timeTracking": true,"hrm":true}}'::jsonb where id=${org.orgId}`,
    );
  });
  await configureTimesheetReviewFixture(org.orgId, actor, false);
  session.user = {
    id: actor,
    orgId: org.orgId,
    name: "Auditor",
    email: "auditor@example.test",
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: org.orgId,
    homeOrgId: org.orgId,
    homeUserId: actor,
  };
  const employee = randomUUID();
  const leaveType = randomUUID();
  await withBypassContext(async () => {
    await db.execute(
      sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom) values (${employee},${org.orgId},'employee','Leave Worker',${org.subsidiaryId},true,'{}'::jsonb)`,
    );
    await db.execute(
      sql`insert into employee_roles(id,org_id,party_id,is_active) values (${randomUUID()},${org.orgId},${employee},true)`,
    );
    await db.execute(
      sql`update users set party_id = ${employee} where id = ${actor} and org_id = ${org.orgId}`,
    );
    await db.execute(
      sql`insert into hrm_leave_types(id,org_id,code,name) values (${leaveType},${org.orgId},'VAC','Vacation')`,
    );
  });
  const { seedEmployment } = await import("@openbooks/engine/testing/hrm-harness");
  const { createLeavePolicy, fileLeaveRequest, submitLeaveRequest } =
    await import("@openbooks/engine/hrm/leave");
  const { employmentId } = await withBypassContext(() =>
    seedEmployment(org.orgId, org.subsidiaryId, { workerPartyId: employee, from: "2026-01-01" }),
  );
  await withOrgContext(org.orgId, () =>
    createLeavePolicy({
      orgId: org.orgId,
      actorId: actor,
      leaveTypeId: leaveType,
      accrualRule: { kind: "unlimited" },
      effectiveFrom: "2026-01-01",
    }),
  );
  const leave = await withOrgContext(org.orgId, () =>
    fileLeaveRequest({
      orgId: org.orgId,
      actorId: actor,
      employmentId,
      leaveTypeId: leaveType,
      startsOn: "2026-08-03",
      endsOn: "2026-08-07",
      hours: "40.00",
      reason: "Family week",
    }),
  );
  const leaveRequest = leave.id;
  await withOrgContext(org.orgId, () =>
    submitLeaveRequest({ orgId: org.orgId, actorId: actor, requestId: leaveRequest }),
  );
  const put = (rows: unknown[], expectedRevision?: string) =>
    withOrgContext(org.orgId, async () => {
      const revision = expectedRevision ?? (await loadWeek(org.orgId, employee, WEEK)).revision;
      return PUT(
        new Request("http://declaration.local/api/timesheets", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ employee, week: WEEK, rows, expectedRevision: revision }),
        }),
      );
    });
  const entries = () =>
    withOrgContext(
      org.orgId,
      async () =>
        await db.execute<{ hours: string; memo: string | null; worked_on: string; status: string }>(
          sql`
    select hours::text as hours, memo, worked_on::text as worked_on, status from time_entries where org_id = ${org.orgId} order by worked_on, id`,
          "objects",
        ),
    );
  const close = async () => {
    session.user = null;
    await withBypassContext(async () => {
      await db.execute(sql`delete from time_entries where org_id = ${org.orgId}`);
    });
    await dropScratchOrg(org.orgId);
  };
  return { org, actor, employee, leaveRequest, put, entries, close };
}

test("a memo with zero hours saves as a declaration line and reads back", async () => {
  const f = await fixture();
  try {
    const res = await f.put([{ memo: MEMO, hours: ["0", "", "", "", "", "", ""] }]);
    assert.equal(res.status, 200, await res.text());
    const stored = await f.entries();
    assert.equal(stored.length, 1, "the declaration persists as exactly one entry");
    assert.equal(stored[0]!.memo, MEMO);
    assert.equal(Number(stored[0]!.hours), 0);
    assert.equal(stored[0]!.worked_on, WEEK);
    assert.equal(stored[0]!.status, "draft");
    const reopened = await withOrgContext(f.org.orgId, () =>
      loadWeek(f.org.orgId, f.employee, WEEK),
    );
    assert.equal(reopened.rows.length, 1, "reopening the week shows the declaration row");
    assert.equal(reopened.rows[0]!.memo, MEMO);
    assert.deepEqual(reopened.leaveCover, [
      {
        requestId: f.leaveRequest,
        leaveType: "VAC — Vacation",
        from: "2026-08-03",
        to: "2026-08-07",
      },
    ]);
  } finally {
    await f.close();
  }
});

test("re-saving the declaration week is stable and keeps one entry", async () => {
  const f = await fixture();
  try {
    const first = await f.put([{ memo: MEMO, hours: ["0", "", "", "", "", "", ""] }]);
    assert.equal(first.status, 200, await first.clone().text());
    const week = (await first.json()) as {
      revision: string;
      rows: { memo: string | null; hours: string[] }[];
    };
    assert.equal(week.rows.length, 1);
    const second = await f.put([{ memo: MEMO, hours: week.rows[0]!.hours }], week.revision);
    assert.equal(second.status, 200, await second.text());
    assert.equal(
      (await f.entries()).length,
      1,
      "a replayed declaration must not duplicate the entry",
    );
  } finally {
    await f.close();
  }
});

test("the saved declaration submits through the normal submit", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.put([{ memo: MEMO, hours: ["0", "", "", "", "", "", ""] }])).status, 200);
    const res = await withOrgContext(f.org.orgId, () =>
      submitWeek(
        new Request("http://declaration.local/api/timesheets/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ employee: f.employee, week: WEEK }),
        }),
      ),
    );
    assert.equal(res.status, 200, await res.text());
    const stored = await f.entries();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.status, "submitted");
    const header = await withOrgContext(
      f.org.orgId,
      async () =>
        (
          await db.execute<{ status: string }>(
            sql`
      select status from timesheet_weeks where org_id = ${f.org.orgId} and employee_party_id = ${f.employee}`,
            "objects",
          )
        )[0],
    );
    assert.equal(header!.status, "submitted");
  } finally {
    await f.close();
  }
});

test("a saved declaration does not block the declare-no-hours submit", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.put([{ memo: MEMO, hours: ["0", "", "", "", "", "", ""] }])).status, 200);
    const res = await withOrgContext(f.org.orgId, () =>
      submitWeek(
        new Request("http://declaration.local/api/timesheets/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            employee: f.employee,
            week: WEEK,
            noHours: true,
            reason: "On vacation all week",
          }),
        }),
      ),
    );
    assert.equal(res.status, 200, await res.text());
    const rows = await withOrgContext(
      f.org.orgId,
      async () =>
        await db.execute<{ changes: unknown }>(
          sql`
      select changes from audit_log where org_id = ${f.org.orgId} and table_name = 'timesheet_weeks' and changes->>'event' = 'no_hours_declared'`,
          "objects",
        ),
    );
    assert.equal(rows.length, 1, "the declaration leaves exactly one audit row");
    const changes = rows[0]!.changes as { reason: string; leaveRequests: { requestId: string }[] };
    assert.equal(changes.reason, "On vacation all week");
    assert.deepEqual(
      changes.leaveRequests.map((leave) => leave.requestId),
      [f.leaveRequest],
    );
  } finally {
    await f.close();
  }
});

test("approving a zero-hour declaration needs no wage row and posts no journals", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.put([{ memo: MEMO, hours: ["0", "", "", "", "", "", ""] }])).status, 200);
    const submitted = await withOrgContext(f.org.orgId, () =>
      submitWeek(
        new Request("http://declaration.local/api/timesheets/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ employee: f.employee, week: WEEK }),
        }),
      ),
    );
    assert.equal(submitted.status, 200, await submitted.text());
    // No labor_cost_rates row covers this employee: approval of real hours
    // would refuse for a missing wage rate. Zero hours cost nothing.
    // Approval comes from a second person: self-approval stays prevented.
    const approver = randomUUID();
    await withBypassContext(async () => {
      await db.execute(
        sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom) values (${approver},${f.org.orgId},'employee','Declaration Approver',${f.org.subsidiaryId},true,'{}'::jsonb)`,
      );
      await db.execute(
        sql`insert into employee_roles(id,org_id,party_id,is_active) values (${randomUUID()},${f.org.orgId},${approver},true)`,
      );
      await db.execute(
        sql`update users set party_id = ${approver} where id = ${f.actor} and org_id = ${f.org.orgId}`,
      );
    });
    const journalsBefore = await withOrgContext(
      f.org.orgId,
      async () =>
        (
          await db.execute<{ n: string }>(
            sql`
      select count(*) as n from journal_entries where org_id = ${f.org.orgId}`,
            "objects",
          )
        )[0]!.n,
    );
    const res = await withOrgContext(f.org.orgId, () =>
      decideTimesheetFixture({
        orgId: f.org.orgId,
        ...{ employee: f.employee, week: WEEK },
        decision: "approved",
      }),
    );
    assert.equal(res.status, 200, await res.text());
    const journalsAfter = await withOrgContext(
      f.org.orgId,
      async () =>
        (
          await db.execute<{ n: string }>(
            sql`
      select count(*) as n from journal_entries where org_id = ${f.org.orgId}`,
            "objects",
          )
        )[0]!.n,
    );
    assert.equal(journalsAfter, journalsBefore, "a zero-hour declaration posts no journals");
    const header = await withOrgContext(
      f.org.orgId,
      async () =>
        (
          await db.execute<{ status: string }>(
            sql`
      select status from timesheet_weeks where org_id = ${f.org.orgId} and employee_party_id = ${f.employee}`,
            "objects",
          )
        )[0],
    );
    assert.equal(header!.status, "approved");
  } finally {
    await f.close();
  }
});
