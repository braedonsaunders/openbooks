import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql, type SQL } from "drizzle-orm";
import { RESOURCING_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/resourcing.ts";
import { decideGate, ReleaseError } from "../flows/gates.ts";
import { installEngineSeams } from "../composition/install.ts";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrgReporting, seedApprovalFlow, seedFlowActors } from "../testing/fixtures.ts";
import { ResourcingRefusal } from "./errors.ts";
import { createResourceRequest, submitResourceRequest, cancelResourceRequest } from "./requests.ts";
import { upsertAssignment } from "./assignments.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
type Fixture = { orgId: string; actorId: string; approverId: string; subsidiaryId: string; projectId: string; employeePartyId: string };

async function write(query: SQL) {
  const result = await db.execute(query);
  assert.equal(result.rowCount, 1);
}
async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const data = await withBypassContext(async () => {
      const actors = await seedFlowActors(org.orgId), projectId = randomUUID(), employeePartyId = randomUUID();
      await write(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"flows":true,"resourcing":true,"resourceRequests":true}'::jsonb) where id = ${org.orgId} returning id`);
      for (const query of [
        sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${employeePartyId}, ${org.orgId}, 'person', 'Consultant', ${org.subsidiaryId}, true, '{}'::jsonb) returning id`,
        sql`insert into employee_roles (org_id, party_id, job_title, hired_on, is_active) values (${org.orgId}, ${employeePartyId}, 'Consultant', '2026-01-01', true) returning party_id`,
        sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom) values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, ${`RQ-${projectId.slice(0, 6)}`}, 'Resource request project', ${org.customerId}, 'active', true, '{}'::jsonb) returning id`,
      ]) await write(query);
      return { actorId: actors.submitterId, approverId: actors.approver1Id, projectId, employeePartyId };
    });
    await run({ orgId: org.orgId, subsidiaryId: org.subsidiaryId, ...data });
  } finally { await withBypassContext(() => dropScratchOrgReporting(org.orgId)); }
}
const ctx = (f: Fixture) => ({ orgId: f.orgId, actorId: f.actorId, allowedSubsidiaryIds: null });
const requestInput = (f: Fixture, firstWeek = "2026-10-04", lastWeek = firstWeek) => ({ ...ctx(f), projectId: f.projectId, employeePartyId: f.employeePartyId, firstWeek, lastWeek, hoursPerWeek: "50.0000", reason: "staffing commitment" });

async function addApprovalFlow(f: Fixture): Promise<void> { await withBypassContext(() => seedApprovalFlow(f.orgId, { subjectKind: RESOURCING_REQUEST_SUBJECT_KIND, assignees: [{ type: "user", userId: f.approverId }], mode: "any" })); }
async function gateForRequest(f: Fixture, runId: string): Promise<string> {
  const rows = await withBypassContext(() => db.execute<{ id: string }>(sql`select id from flow_gates where org_id = ${f.orgId} and run_id = ${runId} and status = 'pending'`));
  assert.equal(rows.rows.length, 1);
  return rows.rows[0]!.id;
}
async function decide(f: Fixture, gateId: string, decision: "approved" | "rejected", comment?: string) { installEngineSeams(); return decideGate({ gateId, decision, userId: f.approverId, allowedSubsidiaryIds: null, comment }); }

test("submit without an authored flow refuses with the existing Flows remedy", enabled, async () => withFixture(async (f) => {
  const draft = await createResourceRequest(requestInput(f));
  await assert.rejects(submitResourceRequest({ ...ctx(f), requestId: draft.id }), (error: unknown) => {
    assert.ok(error instanceof ResourcingRefusal);
    assert.equal(error.code, "resource_request_no_flow");
    assert.equal(error.remedy, "configure a flow for resource requests (Admin → Flows)");
    return true;
  });
  const row = (await withBypassContext(() => db.execute<{ status: string; flow_instance_id: string | null }>(sql`select status, flow_instance_id from res_requests where org_id = ${f.orgId} and id = ${draft.id}`))).rows[0];
  assert.deepEqual(row, { status: "draft", flow_instance_id: null });
  const cancelled = await cancelResourceRequest({ ...ctx(f), requestId: draft.id, reason: "No longer needed" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.decisionComment, "No longer needed");
}));

test("approval creates one hard request-linked assignment for every requested Sunday", enabled, async () => withFixture(async (f) => {
  await addApprovalFlow(f);
  const prior = await upsertAssignment({ ...ctx(f), projectId: f.projectId, employeePartyId: f.employeePartyId, weekStart: "2026-10-04", plannedHours: "8.0000" });
  const otherProjectId = randomUUID();
  await withBypassContext(() => write(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom) values (${otherProjectId}, ${f.orgId}, ${f.subsidiaryId}, ${`RQ-${otherProjectId.slice(0, 6)}`}, 'Other staffing project', (select customer_id from projects where org_id = ${f.orgId} and id = ${f.projectId}), 'active', true, '{}'::jsonb) returning id`));
  await upsertAssignment({ ...ctx(f), projectId: otherProjectId, employeePartyId: f.employeePartyId, weekStart: "2026-10-04", plannedHours: "40.0000" });
  const draft = await createResourceRequest(requestInput(f, "2026-10-04", "2026-10-11"));
  const submitted = await submitResourceRequest({ ...ctx(f), requestId: draft.id });
  await decide(f, await gateForRequest(f, submitted.flowInstanceId!), "approved", "Approved for busy season");
  const rows = await withBypassContext(() => db.execute<{ id: string; week_start: string; booking: string; source: string; request_id: string; planned_hours: string }>(sql`select id::text, week_start::text, booking, source, request_id::text, planned_hours::text from res_assignments where org_id = ${f.orgId} and request_id = ${draft.id} order by week_start`));
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.rows[0]?.id, prior.assignment.id);
  assert.notEqual(rows.rows[0]?.id, rows.rows[1]?.id);
  assert.deepEqual(rows.rows.map(({ week_start, booking, source, request_id, planned_hours }) => ({ week_start, booking, source, request_id, planned_hours })), [
    { week_start: "2026-10-04", booking: "hard", source: "request", request_id: draft.id, planned_hours: "50.0000" },
    { week_start: "2026-10-11", booking: "hard", source: "request", request_id: draft.id, planned_hours: "50.0000" },
  ]);
  const request = (await withBypassContext(() => db.execute<{ status: string; decision_comment: string | null }>(sql`select status, decision_comment from res_requests where org_id = ${f.orgId} and id = ${draft.id}`))).rows[0];
  assert.equal(request?.status, "approved");
  assert.match(request?.decision_comment ?? "", /Approved for busy season/);
  assert.match(request?.decision_comment ?? "", /Capacity context:.*90\.0000 hard hours/);
}));

test("an assignment refusal leaves the approval pending and creates zero weekly rows", enabled, async () => withFixture(async (f) => {
  await addApprovalFlow(f);
  const draft = await createResourceRequest(requestInput(f)), submitted = await submitResourceRequest({ ...ctx(f), requestId: draft.id });
  const gateId = await gateForRequest(f, submitted.flowInstanceId!);
  await withBypassContext(() => write(sql`insert into work_schedules (org_id, employee_party_id, pattern, effective_from, is_active, created_by, updated_by) values (${f.orgId}, ${f.employeePartyId}, 'varies', '2026-01-01', true, ${f.actorId}, ${f.actorId}) returning id`));
  await assert.rejects(decide(f, gateId, "approved"), (error: unknown) => {
    assert.ok(error instanceof ReleaseError);
    assert.match(error.message, /work schedule declares that hours vary/);
    assert.match(error.message, /still pending/);
    return true;
  });
  const state = (await withBypassContext(() => db.execute<{ request_status: string; gate_status: string; assignments: number }>(sql`select r.status request_status, g.status gate_status, (select count(*)::int from res_assignments a where a.org_id = r.org_id and a.request_id = r.id) assignments from res_requests r join flow_gates g on g.org_id = r.org_id and g.run_id = r.flow_instance_id where r.org_id = ${f.orgId} and r.id = ${draft.id}`))).rows[0];
  assert.deepEqual(state, { request_status: "submitted", gate_status: "pending", assignments: 0 });
}));

test("rejection retains the approver comment and creates no assignments", enabled, async () => withFixture(async (f) => {
  await addApprovalFlow(f);
  const draft = await createResourceRequest(requestInput(f)), submitted = await submitResourceRequest({ ...ctx(f), requestId: draft.id });
  await decide(f, await gateForRequest(f, submitted.flowInstanceId!), "rejected", "Project dates are not confirmed");
  const row = (await withBypassContext(() => db.execute<{ status: string; decided_by: string; decision_comment: string; assignments: number }>(sql`select r.status, r.decided_by::text, r.decision_comment, (select count(*)::int from res_assignments a where a.org_id = r.org_id and a.request_id = r.id) assignments from res_requests r where r.org_id = ${f.orgId} and r.id = ${draft.id}`))).rows[0];
  assert.deepEqual(row, { status: "rejected", decided_by: f.approverId, decision_comment: "Project dates are not confirmed", assignments: 0 });
}));
