import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextResponse } from "next/server";
import { notFound } from "@/lib/api/responses";

const state: { authz: unknown } = { authz: null };
Object.assign(globalThis, { __resourcingRouteState: state, __resourcingNextResponse: NextResponse });
const realAuthz = new URL("../../../lib/authz.ts", import.meta.url).href;
const authzStub = {
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(`
    import { can } from '${realAuthz}';
    export * from '${realAuthz}';
    export async function getAuthz() { return globalThis.__resourcingRouteState.authz }
    export async function guardPermission(permission) {
      const authz = globalThis.__resourcingRouteState.authz;
      if (!authz) return globalThis.__resourcingNextResponse.json({ error: 'unauthorized' }, { status: 401 });
      if (!can(authz, permission)) return globalThis.__resourcingNextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 });
      return authz;
    }
  `),
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/lib/authz" || (specifier === "./authz" && context.parentURL?.includes("/web/lib/feature-gates"))) return authzStub;
    return next(specifier, context);
  },
});

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST: postAssignment } = await import("./assignments/route.ts");
const { GET: getBoard } = await import("./board/route.ts");
const { POST: postRequest } = await import("./requests/route.ts");

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
function written(result: { rowCount: number | null }, label: string): void {
  if (result.rowCount !== 1) throw new Error(`${label} did not affect one row`);
}

test("resourcing routes enforce access, idempotency, scope, and board availability", enabled, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const employeeId = randomUUID();
  const unbookedEmployeeId = randomUUID();
  const projectId = randomUUID();
  const departmentId = randomUUID();
  const weekStart = "2026-10-04";
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Resourcing route operator", "admin"));
    await withBypassContext(async () => {
      written(await db.execute(sql`insert into departments (id, org_id, name, is_active) values (${departmentId}, ${org.orgId}, 'Delivery', true)`), "department setup");
      written(await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${employeeId}, ${org.orgId}, 'person', 'Consultant', ${org.subsidiaryId}, true, '{}'::jsonb)`), "employee setup");
      written(await db.execute(sql`insert into employee_roles (org_id, party_id, job_title, department_id, hired_on, is_active) values (${org.orgId}, ${employeeId}, 'Consultant', ${departmentId}, '2026-01-01', true)`), "employee role setup");
      written(await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${unbookedEmployeeId}, ${org.orgId}, 'person', 'Unbooked consultant', ${org.subsidiaryId}, true, '{}'::jsonb)`), "unbooked employee setup");
      written(await db.execute(sql`insert into employee_roles (org_id, party_id, job_title, department_id, hired_on, is_active) values (${org.orgId}, ${unbookedEmployeeId}, 'Consultant', ${departmentId}, '2026-01-01', true)`), "unbooked employee role setup");
      written(await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom) values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, ${`RS-${projectId.slice(0, 6)}`}, 'Route project', ${org.customerId}, 'active', true, '{}'::jsonb)`), "project setup");
      const scheduleId = randomUUID();
      written(await db.execute(sql`insert into work_schedules (id, org_id, name, employee_party_id, pattern, cycle_days, cycle_anchor, effective_from, is_active, created_by, updated_by) values (${scheduleId}, ${org.orgId}, 'Full time', ${employeeId}, 'cycle', 7, '2026-01-04', '2026-01-01', true, ${actorId}, ${actorId})`), "schedule setup");
      for (const dayIndex of [1, 2, 3, 4, 5]) {
        written(await db.execute(sql`insert into work_schedule_days (org_id, schedule_id, day_index, hours, created_by, updated_by) values (${org.orgId}, ${scheduleId}, ${dayIndex}, '8', ${actorId}, ${actorId})`), "schedule day setup");
      }
      const unbookedScheduleId = randomUUID();
      written(await db.execute(sql`insert into work_schedules (id, org_id, name, employee_party_id, pattern, cycle_days, cycle_anchor, effective_from, is_active, created_by, updated_by) values (${unbookedScheduleId}, ${org.orgId}, 'Full time', ${unbookedEmployeeId}, 'cycle', 7, '2026-01-04', '2026-01-01', true, ${actorId}, ${actorId})`), "unbooked schedule setup");
      for (const dayIndex of [1, 2, 3, 4, 5]) {
        written(await db.execute(sql`insert into work_schedule_days (org_id, schedule_id, day_index, hours, created_by, updated_by) values (${org.orgId}, ${unbookedScheduleId}, ${dayIndex}, '8', ${actorId}, ${actorId})`), "unbooked schedule day setup");
      }
    });

    const authz = (permissions: string[], allowedSubsidiaryIds: Set<string> | null = null) => ({
      user: { id: actorId, orgId: org.orgId, roles: [] }, permissions: new Set(permissions), allowedSubsidiaryIds,
    });
    const call = async (handler: (request: Request) => Promise<Response>, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const request = new Request(`http://resourcing.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const response = await withOrgContext(org.orgId, () => handler(request));
      const text = await response.text();
      return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
    };
    const assignmentBody = { projectId, employeePartyId: employeeId, weekStart, plannedHours: "8.0000" };

    state.authz = authz(["resourcing.manage"]);
    const off = await call(postAssignment, "/api/resourcing/assignments", assignmentBody);
    assert.equal(off.status, 404);
    assert.deepEqual(off.json, { error: "not_found" });
    assert.doesNotMatch(JSON.stringify(off.json), /resourcing/i);

    await withBypassContext(async () => written(await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":true,"resourceRequests":true,"flows":true}'::jsonb) where id = ${org.orgId}`), "feature setup"));
    state.authz = authz(["resourcing.read"]);
    assert.equal((await call(postAssignment, "/api/resourcing/assignments", assignmentBody)).status, 403);

    state.authz = authz(["resourcing.manage"]);
    await withBypassContext(async () => written(await db.execute(sql`update projects set status = 'closed' where org_id = ${org.orgId} and id = ${projectId}`), "project close"));
    const closed = await call(postAssignment, "/api/resourcing/assignments", assignmentBody);
    assert.equal(closed.status, 422);
    assert.equal(closed.json.code, "project_not_active");
    assert.equal(closed.json.remedy, "reopen the project (its status is editable on the project) or choose an active project");
    await withBypassContext(async () => written(await db.execute(sql`update projects set status = 'active' where org_id = ${org.orgId} and id = ${projectId}`), "project reopen"));

    state.authz = authz(["resourcing.manage"], new Set([randomUUID()]));
    const hidden = await call(postAssignment, "/api/resourcing/assignments", assignmentBody);
    const missing = await call(postAssignment, "/api/resourcing/assignments", { ...assignmentBody, projectId: randomUUID() });
    assert.equal(hidden.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(hidden.json, { error: "not_found" });
    assert.equal(hidden.status, missing.status);
    assert.equal(hidden.text, missing.text);
    const canonicalMissing = notFound("record");
    assert.equal(hidden.status, canonicalMissing.status);
    assert.equal(hidden.text, await canonicalMissing.text());

    state.authz = authz(["resourcing.manage", "resourcing.read"]);
    const key = randomUUID();
    const requestBody = { projectId, employeePartyId: employeeId, firstWeek: weekStart, lastWeek: weekStart, hoursPerWeek: "8.0000", reason: "initial staffing" };
    const requestPath = "/api/resourcing/requests";
    const first = await call(postRequest, requestPath, requestBody, { "Idempotency-Key": key });
    const replay = await call(postRequest, requestPath, requestBody, { "Idempotency-Key": key });
    assert.equal(first.status, 201);
    assert.equal(replay.status, 201);
    assert.equal((first.json as { id: string }).id, (replay.json as { id: string }).id);
    const conflict = await call(postRequest, requestPath, { ...requestBody, reason: "changed details" }, { "Idempotency-Key": key });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, "idempotency_key_conflict");
    const persisted = await withBypassContext(() => db.execute<{ rows: string; audits: string }>(sql`
      select (select count(*)::text from res_requests where org_id = ${org.orgId} and id = ${key}) as rows,
             (select count(*)::text from audit_log where org_id = ${org.orgId} and table_name = 'res_requests' and row_id = ${key} and request_id = ${key}) as audits
    `));
    assert.deepEqual(persisted.rows[0], { rows: "1", audits: "1" });

    await call(postAssignment, "/api/resourcing/assignments", assignmentBody);
    await call(postAssignment, "/api/resourcing/assignments", { projectId, jobTitle: "Consultant", weekStart, plannedHours: "4.0000" });
    const requiredCustomKey = "required_staffing_note";
    await withBypassContext(async () => written(await db.execute(sql`
      insert into custom_field_defs
        (id, org_id, target_table, key, label, field_type, config, is_required, is_active, created_by, updated_by)
      values
        (${randomUUID()}, ${org.orgId}, 'res_assignments', ${requiredCustomKey}, 'Staffing note', 'text', '{}'::jsonb, true, true, ${actorId}, ${actorId})
    `), "assignment custom field setup"));
    const missingCustom = await call(postAssignment, "/api/resourcing/assignments", {
      projectId, employeePartyId: employeeId, weekStart, plannedHours: "8.0000", custom: {},
    });
    assert.equal(missingCustom.status, 422);
    assert.equal((missingCustom.json.fields as Record<string, string>)[requiredCustomKey], "Staffing note is required");
    const validCustom = await call(postAssignment, "/api/resourcing/assignments", {
      projectId, employeePartyId: employeeId, weekStart, plannedHours: "8.0000",
      custom: { [requiredCustomKey]: "Reviewed by delivery" },
    });
    assert.equal(validCustom.status, 200);
    assert.equal((validCustom.json.assignment as { custom: Record<string, unknown> }).custom[requiredCustomKey], "Reviewed by delivery");
    // A supplied key with no definition is refused by name instead of being
    // silently dropped: the required value is present, so only the unknown
    // key can explain the refusal.
    const unknownCustom = await call(postAssignment, "/api/resourcing/assignments", {
      projectId, employeePartyId: employeeId, weekStart, plannedHours: "8.0000",
      custom: { [requiredCustomKey]: "Reviewed by delivery", region: "west" },
    });
    assert.equal(unknownCustom.status, 422);
    assert.match(unknownCustom.json.error as string, /unknown custom field: region/);
    assert.match(unknownCustom.json.remedy as string, /Custom Fields/);
    const board = await call(getBoard, `/api/resourcing/board?firstSunday=${weekStart}&lastSunday=${weekStart}&departmentId=${departmentId}`);
    assert.equal(board.status, 200);
    assert.equal((board.json.rows as unknown[]).length, 1);
    assert.equal(board.json.excludedGenericAssignmentCount, 1);
    assert.ok((board.json.people as { partyId: string }[]).some((person) => person.partyId === unbookedEmployeeId));
    assert.ok((board.json.forecast as { bench: { employeePartyId: string }[] }).bench.some((person) => person.employeePartyId === unbookedEmployeeId));
    const figure = (board.json.forecast as { personWeeks: { employeePartyId: string; capacity: { hours: string | null } }[] }).personWeeks.find((person) => person.employeePartyId === employeeId);
    assert.ok(figure);
    assert.equal(figure.employeePartyId, employeeId);
    assert.equal(typeof figure.capacity.hours, "string");
  } finally {
    state.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});
