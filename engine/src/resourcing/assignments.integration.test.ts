import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { ResourcingRefusal } from "./errors.ts";
import { deleteAssignment, releaseAssignment, upsertAssignment } from "./assignments.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
type Fixture = { org: Awaited<ReturnType<typeof createScratchOrg>>; actorId: string; employeePartyId: string; projectId: string };
type Overrides = {
  weekStart?: string; plannedHours?: unknown; isBillable?: boolean; billItemId?: string | null;
  projectTaskId?: string | null; booking?: "soft" | "hard"; source?: "manual" | "request" | "pipeline";
  requestId?: string | null; allowedSubsidiaryIds?: ReadonlySet<string> | null;
};
const affected = (result: { rowCount: number | null }, label: string) => {
  if (result.rowCount !== 1) throw new Error(`${label} did not affect one row`);
};

async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const ids = await withBypassContext(async () => {
      const actorId = await createScratchUser(org.orgId, "Resourcing operator", "admin");
      const employeePartyId = randomUUID();
      const projectId = randomUUID();
      affected(await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":true}'::jsonb) where id = ${org.orgId}`), "feature setup");
      affected(await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${employeePartyId}, ${org.orgId}, 'person', 'Consultant', ${org.subsidiaryId}, true, '{}'::jsonb)`), "employee setup");
      affected(await db.execute(sql`insert into employee_roles (org_id, party_id, job_title, hired_on, is_active) values (${org.orgId}, ${employeePartyId}, 'Consultant', '2026-01-01', true)`), "role setup");
      affected(await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom) values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, ${`RS-${projectId.slice(0, 6)}`}, 'Assignment project', ${org.customerId}, 'active', true, '{}'::jsonb)`), "project setup");
      return { actorId, employeePartyId, projectId };
    });
    await run({ org, ...ids });
  } finally { await dropScratchOrgReporting(org.orgId); }
}

const context = (f: Fixture) => ({ orgId: f.org.orgId, actorId: f.actorId, allowedSubsidiaryIds: null });
const base = (f: Fixture, extra: Overrides = {}) => ({
  ...context(f), projectId: f.projectId, weekStart: "2026-10-04", plannedHours: "8.0000", ...extra,
});
const input = (f: Fixture, extra: Overrides = {}) => ({ ...base(f, extra), employeePartyId: f.employeePartyId });
const genericInput = (f: Fixture, jobTitle: string, extra: Overrides = {}) => ({ ...base(f, extra), jobTitle });
const refused = (code: string, remedy?: string) => (error: unknown) => {
  assert.ok(error instanceof ResourcingRefusal);
  assert.equal(error.code, code);
  if (remedy) assert.equal(error.remedy, remedy);
  return true;
};

test("terminal projects refuse assignment writes with the supported remedy", enabled, async () => fixture(async (f) => {
  for (const status of ["closed", "cancelled"]) {
    affected(await withBypassContext(() => db.execute(sql`update projects set status = ${status} where org_id = ${f.org.orgId} and id = ${f.projectId}`)), "project status update");
    await assert.rejects(upsertAssignment(input(f)), (error: unknown) => {
      assert.ok(refused("project_not_active", "reopen the project (its status is editable on the project) or choose an active project")(error));
      assert.match((error as Error).message, new RegExp(status));
      return true;
    });
  }
  const rows = await withBypassContext(() => db.execute<{ count: string }>(sql`select count(*)::text count from res_assignments where org_id = ${f.org.orgId}`));
  assert.equal(rows.rows[0]?.count, "0");
}));

test("booking-key upserts and every source retain their row and planning values", enabled, async () => fixture(async (f) => {
  const taskId = randomUUID(), requestId = randomUUID();
  await withBypassContext(async () => {
    affected(await db.execute(sql`insert into project_tasks (id, org_id, project_id, name, created_by, updated_by) values (${taskId}, ${f.org.orgId}, ${f.projectId}, 'Consulting', ${f.actorId}, ${f.actorId})`), "task setup");
    affected(await db.execute(sql`insert into res_requests (id, org_id, project_id, employee_party_id, first_week, last_week, hours_per_week, status, created_by, updated_by) values (${requestId}, ${f.org.orgId}, ${f.projectId}, ${f.employeePartyId}, '2026-10-18', '2026-10-18', '8.0000', 'approved', ${f.actorId}, ${f.actorId})`), "request setup");
  });
  const first = await upsertAssignment(input(f, { plannedHours: "50.0000", booking: "soft", billItemId: f.org.items.service, projectTaskId: taskId }));
  const updated = await upsertAssignment(input(f, { plannedHours: "50.0000", booking: "hard", isBillable: false, billItemId: f.org.items.service, projectTaskId: taskId }));
  assert.equal(updated.assignment.id, first.assignment.id);
  assert.deepEqual([updated.assignment.booking, updated.assignment.isBillable, updated.assignment.plannedHours], ["hard", false, "50.0000"]);
  assert.deepEqual([updated.weeklyTotals?.hardHours, updated.weeklyTotals?.availableHours, updated.weeklyTotals?.overallocated], ["50.0000", "-10.0000", true]);
  const pipeline = await upsertAssignment(input(f, { weekStart: "2026-10-11", plannedHours: "6.0000", booking: "soft", source: "pipeline" }));
  const request = await upsertAssignment(input(f, { weekStart: "2026-10-18", source: "request", requestId }));
  const role = await upsertAssignment(genericInput(f, "consultant", { weekStart: "2026-10-25", source: "pipeline" }));
  const rows = await withBypassContext(() => db.execute<{ id: string; source: string; request_id: string | null; job_title: string | null }>(sql`select id, source, request_id, job_title from res_assignments where org_id = ${f.org.orgId}`));
  assert.equal(rows.rows.length, 4);
  assert.deepEqual(new Set(rows.rows.map((row) => row.source)), new Set(["manual", "pipeline", "request"]));
  assert.ok(rows.rows.some((row) => row.id === request.assignment.id && row.request_id === requestId));
  assert.ok(rows.rows.some((row) => row.id === role.assignment.id && row.job_title === "consultant"));
  assert.ok(rows.rows.some((row) => row.id === pipeline.assignment.id));
}));

test("approved time protects history; release and generic deletion update active state", enabled, async () => fixture(async (f) => {
  const created = await upsertAssignment(input(f));
  await withBypassContext(async () => affected(await db.execute(sql`insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, status, approved_by, approved_at, created_by, updated_by) values (${f.org.orgId}, ${f.employeePartyId}, '2026-10-05', '4.0000', ${f.projectId}, 'approved', ${f.actorId}, now(), ${f.actorId}, ${f.actorId})`), "approved time setup"));
  await assert.rejects(deleteAssignment({ ...context(f), assignmentId: created.assignment.id }), refused("assignment_has_approved_time", "release it; plan-vs-actual history is kept"));
  const released = await releaseAssignment({ ...context(f), assignmentId: created.assignment.id });
  assert.equal(released.assignment.state, "released");
  assert.equal(released.weeklyTotals?.hardHours, "0.0000");
  await assert.rejects(releaseAssignment({ ...context(f), assignmentId: created.assignment.id }), refused("assignment_not_active"));
  const row = await upsertAssignment(genericInput(f, "CONSULTANT", { weekStart: "2026-10-11" }));
  await deleteAssignment({ ...context(f), assignmentId: row.assignment.id });
  const remains = await withBypassContext(() => db.execute(sql`select id from res_assignments where org_id = ${f.org.orgId} and id = ${row.assignment.id}`));
  assert.equal(remains.rows.length, 0);
}));

test("invalid hours, week, links, scope, feature, title, and capacity refuse by name", enabled, async () => fixture(async (f) => {
  const base = input(f);
  for (const [values, code] of [
    [{ plannedHours: "12,5" }, "invalid_assignment_hours"],
    [{ weekStart: "2026-10-05" }, "assignment_week_must_start_sunday"],
    [{ plannedHours: "0.0000" }, "assignment_hours_out_of_range"],
    [{ plannedHours: "168.0001" }, "assignment_hours_out_of_range"],
    [{ billItemId: randomUUID() }, "assignment_bill_item_unknown"],
    [{ projectTaskId: randomUUID() }, "assignment_project_task_unknown"],
  ] as const) await assert.rejects(upsertAssignment({ ...base, ...values }), refused(code));
  await assert.rejects(upsertAssignment({ ...base, plannedHours: "12,5" }), (error: unknown) => {
    assert.ok(error instanceof ResourcingRefusal);
    assert.match(error.message, /as the decimal point/);
    assert.match(error.message, /12\.5/);
    return true;
  });
  await assert.rejects(upsertAssignment(genericInput(f, "Unknown")), refused("assignment_job_title_unknown", "use an existing job title or add it to an employee's role"));
  await assert.rejects(upsertAssignment({ ...base, allowedSubsidiaryIds: new Set([randomUUID()]) }), ScopeNotFoundError);
  affected(await withBypassContext(() => db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":false}'::jsonb) where id = ${f.org.orgId}`)), "feature update");
  await assert.rejects(upsertAssignment(base), refused("resourcing_feature_disabled", "turn on Resourcing in Company Settings → Features"));
  affected(await withBypassContext(() => db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":true}'::jsonb) where id = ${f.org.orgId}`)), "feature restore");
  await withBypassContext(async () => affected(await db.execute(sql`insert into work_schedules (org_id, employee_party_id, pattern, effective_from, is_active, created_by, updated_by) values (${f.org.orgId}, ${f.employeePartyId}, 'varies', '2026-01-01', true, ${f.actorId}, ${f.actorId})`), "schedule setup"));
  await assert.rejects(upsertAssignment({ ...base, allowedSubsidiaryIds: null }), refused("capacity_unknown", "give this person a cycle schedule in Setup → Payroll → Work schedules"));
}));
