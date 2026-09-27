import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql, type SQL } from "drizzle-orm";
import { RESOURCING_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/resourcing.ts";
import { featureEnabled, FEATURES } from "../organization/feature-registry.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { decideGate, ReleaseError } from "../flows/gates.ts";
import { installEngineSeams } from "../composition/install.ts";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrgReporting, seedApprovalFlow, seedFlowActors } from "../testing/fixtures.ts";
import { ResourcingRefusal } from "./errors.ts";
import { createRetainer, draftHoursDrawdown } from "./retainers.ts";
import { cancelResourceRequest, createResourceRequest, submitResourceRequest } from "./requests.ts";
import { deleteAssignment, releaseAssignment, upsertAssignment } from "./assignments.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
type Fixture = { orgId: string; actorId: string; approverId: string; customerId: string; serviceItemId: string; projectId: string; employeePartyId: string };
const KEYS = { projects: true, flows: true, revenueRecognition: true, resourcing: true, resourceRequests: true, retainerBilling: true };
const ctx = (f: Fixture) => ({ orgId: f.orgId, actorId: f.actorId, allowedSubsidiaryIds: null });
const assignmentInput = (f: Fixture, weekStart: string) => ({ ...ctx(f), projectId: f.projectId, employeePartyId: f.employeePartyId, weekStart, plannedHours: "8.0000" });
const requestInput = (f: Fixture, firstWeek = "2026-10-04") => ({ ...ctx(f), projectId: f.projectId, employeePartyId: f.employeePartyId, firstWeek, lastWeek: firstWeek, hoursPerWeek: "8.0000", reason: "staffing plan" });
async function withFixture(run: (f: Fixture) => Promise<void>, initializeFeatures = true): Promise<void> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(async () => {
      const people = await seedFlowActors(org.orgId), projectId = randomUUID(), employeePartyId = randomUUID();
      if (initializeFeatures) await write(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(KEYS)}::jsonb, true) where id = ${org.orgId} returning id`);
      for (const query of [
        sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${employeePartyId}, ${org.orgId}, 'person', 'Consultant', ${org.subsidiaryId}, true, '{}'::jsonb) returning id`,
        sql`insert into employee_roles (org_id, party_id, job_title, hired_on, is_active) values (${org.orgId}, ${employeePartyId}, 'Consultant', '2026-01-01', true) returning party_id`,
        sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom) values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, ${`FF-${projectId.slice(0, 6)}`}, 'Resource planning project', ${org.customerId}, 'active', true, '{}'::jsonb) returning id`,
      ]) await write(query);
      return { actorId: people.submitterId, approverId: people.approver1Id, projectId, employeePartyId };
    });
    await run({ orgId: org.orgId, customerId: org.customerId, serviceItemId: org.items.service, ...actors });
  } finally { await withBypassContext(() => dropScratchOrgReporting(org.orgId)); }
}
async function write(query: SQL) {
  const result = await db.execute(query);
  assert.equal(result.rowCount, 1);
}
async function setFeatures(f: Fixture, values: Record<string, boolean>): Promise<void> {
  const rows = await withBypassContext(() => db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(values)}::jsonb, true) where id = ${f.orgId} returning id`));
  assert.equal(rows.rowCount, 1);
}
async function pendingRequest(f: Fixture) {
  await withBypassContext(() => seedApprovalFlow(f.orgId, { subjectKind: RESOURCING_REQUEST_SUBJECT_KIND, assignees: [{ type: "user", userId: f.approverId }], mode: "any" }));
  const draft = await createResourceRequest(requestInput(f));
  const submitted = await submitResourceRequest({ ...ctx(f), requestId: draft.id });
  const gates = await withBypassContext(() => db.execute<{ id: string }>(sql`select id from flow_gates where org_id = ${f.orgId} and run_id = ${submitted.flowInstanceId} and status = 'pending'`));
  assert.equal(gates.rows.length, 1);
  return { draft, gateId: gates.rows[0]!.id };
}
async function decide(f: Fixture, gateId: string) { installEngineSeams(); return decideGate({ gateId, decision: "approved", userId: f.approverId, allowedSubsidiaryIds: null }); }
async function createTestRetainer(f: Fixture, totalHours = "5.0000") { return createRetainer({ ...ctx(f), projectId: f.projectId, customerPartyId: f.customerId, kind: "hours", totalHours, unitRate: "100.0000", startsOn: "2026-10-01", endsOn: "2026-10-31", retainerItemId: f.serviceItemId }); }
function refused(code: string) {
  return (error: unknown) => { assert.ok(error instanceof ResourcingRefusal); assert.equal(error.code, code); return true; };
}

test("fresh organizations resolve the planning features off", enabled, async () => withFixture(async (f) => {
  const keys = ["resourcing", "resourceRequests", "retainerBilling"] as const;
  for (const key of keys) assert.equal(await withBypassContext(() => orgFeatureEnabled(f.orgId, key)), false, `${key} starts off`);
  const defaults = Object.fromEntries(FEATURES.map(({ key, defaultEnabled }) => [key, defaultEnabled]));
  for (const key of keys) assert.equal(featureEnabled(defaults, key), false);
}, false));

test("child features remain off whenever a parent or required feature is off", enabled, async () => withFixture(async (f) => {
  const check = async (values: Record<string, boolean>, key: "resourcing" | "resourceRequests" | "retainerBilling") => {
    await setFeatures(f, values);
    assert.equal(featureEnabled(values, key), false);
    assert.equal(await withBypassContext(() => orgFeatureEnabled(f.orgId, key)), false);
  };
  await check({ projects: false, resourcing: true, resourceRequests: true, flows: true, retainerBilling: true, revenueRecognition: true }, "resourcing");
  await check({ projects: true, resourcing: false, resourceRequests: true, flows: true, retainerBilling: true, revenueRecognition: true }, "resourceRequests");
  await check({ projects: true, resourcing: false, resourceRequests: true, flows: true, retainerBilling: true, revenueRecognition: true }, "retainerBilling");
  await check({ projects: true, resourcing: true, resourceRequests: true, flows: false, retainerBilling: true, revenueRecognition: true }, "resourceRequests");
  await check({ projects: true, resourcing: true, resourceRequests: true, flows: true, retainerBilling: true, revenueRecognition: false }, "retainerBilling");
}));

test("all service writes refuse by feature name and preserve rows while off", enabled, async () => withFixture(async (f) => {
  const first = await upsertAssignment(assignmentInput(f, "2026-10-04")), second = await upsertAssignment(assignmentInput(f, "2026-10-11"));
  const submitted = await pendingRequest(f), draft = await createResourceRequest(requestInput(f, "2026-10-18"));
  const retainer = await createTestRetainer(f, "20.0000");
  await withBypassContext(() => write(sql`update res_retainers set state = 'active' where org_id = ${f.orgId} and id = ${retainer.id} returning id`));
  await withBypassContext(() => write(sql`insert into time_entries (org_id, employee_party_id, project_id, worked_on, hours, status, is_billable, billing_status, created_by, updated_by) values (${f.orgId}, ${f.employeePartyId}, ${f.projectId}, '2026-10-05', '2.0000', 'approved', true, 'unbilled', ${f.actorId}, ${f.actorId}) returning id`));
  await setFeatures(f, { resourcing: false });
  await assert.rejects(upsertAssignment(assignmentInput(f, "2026-10-18")), refused("resourcing_feature_disabled"));
  await assert.rejects(releaseAssignment({ ...ctx(f), assignmentId: first.assignment.id }), refused("resourcing_feature_disabled"));
  await assert.rejects(deleteAssignment({ ...ctx(f), assignmentId: second.assignment.id }), refused("resourcing_feature_disabled"));
  const assignmentCounts = await withBypassContext(() => db.execute<{ assignments: number }>(sql`select count(*)::int assignments from res_assignments where org_id = ${f.orgId}`));
  assert.equal(assignmentCounts.rows[0]?.assignments, 2);
  await setFeatures(f, { resourcing: true, resourceRequests: false });
  await assert.rejects(createResourceRequest(requestInput(f)), refused("resource_requests_feature_disabled"));
  await assert.rejects(submitResourceRequest({ ...ctx(f), requestId: draft.id }), refused("resource_requests_feature_disabled"));
  await assert.rejects(cancelResourceRequest({ ...ctx(f), requestId: submitted.draft.id, reason: "cancel" }), refused("resource_requests_feature_disabled"));
  const requestCounts = await withBypassContext(() => db.execute<{ requests: number }>(sql`select count(*)::int requests from res_requests where org_id = ${f.orgId}`));
  assert.equal(requestCounts.rows[0]?.requests, 2);
  await setFeatures(f, { resourceRequests: true, retainerBilling: false });
  await assert.rejects(createTestRetainer(f), refused("retainer_billing_disabled"));
  await assert.rejects(draftHoursDrawdown({ ...ctx(f), retainerId: retainer.id, sunday: "2026-10-04" }), refused("retainer_billing_disabled"));
  const drawdownCounts = await withBypassContext(() => db.execute<{ drawdowns: number }>(sql`select count(*)::int drawdowns from res_retainer_drawdowns where org_id = ${f.orgId}`));
  assert.equal(drawdownCounts.rows[0]?.drawdowns, 0);
}));

test("a release while Resource Requests is off rolls back and can be retried", enabled, async () => withFixture(async (f) => {
  const { draft, gateId } = await pendingRequest(f);
  await setFeatures(f, { resourceRequests: false });
  await assert.rejects(decide(f, gateId), (error: unknown) => { assert.ok(error instanceof ReleaseError); assert.match(error.message, /Resource requests are disabled/); return true; });
  const state = async () => (await withBypassContext(() => db.execute<{ request: string; gate: string; count: number }>(sql`select r.status request, g.status gate, (select count(*)::int from res_assignments a where a.org_id = r.org_id and a.request_id = r.id) count from res_requests r join flow_gates g on g.org_id = r.org_id and g.run_id = r.flow_instance_id where r.org_id = ${f.orgId} and r.id = ${draft.id}`))).rows[0];
  assert.deepEqual(await state(), { request: "submitted", gate: "pending", count: 0 });
  await setFeatures(f, { resourceRequests: true });
  await decide(f, gateId);
  assert.deepEqual(await state(), { request: "approved", gate: "approved", count: 1 });
}));

test("turning planning features off preserves rows and re-enabling restores writes", enabled, async () => withFixture(async (f) => {
  const assignment = await upsertAssignment(assignmentInput(f, "2026-10-04")), { draft: request } = await pendingRequest(f);
  const retainer = await createTestRetainer(f, "20.0000");
  await withBypassContext(() => write(sql`update res_retainers set state = 'active' where org_id = ${f.orgId} and id = ${retainer.id} returning id`));
  await withBypassContext(() => write(sql`insert into time_entries (org_id, employee_party_id, project_id, worked_on, hours, status, is_billable, billing_status, created_by, updated_by) values (${f.orgId}, ${f.employeePartyId}, ${f.projectId}, '2026-10-05', '2.0000', 'approved', true, 'unbilled', ${f.actorId}, ${f.actorId}) returning id`));
  const drawdown = await draftHoursDrawdown({ ...ctx(f), retainerId: retainer.id, sunday: "2026-10-04" });
  const snapshot = async () => withBypassContext(() => db.execute<{ assignment: string; request: string; retainer: string; drawdown: string }>(sql`
    select (select to_jsonb(a)::text from res_assignments a where org_id = ${f.orgId} and id = ${assignment.assignment.id}) assignment,
      (select to_jsonb(r)::text from res_requests r where org_id = ${f.orgId} and id = ${request.id}) request,
      (select to_jsonb(r)::text from res_retainers r where org_id = ${f.orgId} and id = ${retainer.id}) retainer,
      (select to_jsonb(d)::text from res_retainer_drawdowns d where org_id = ${f.orgId} and id = ${drawdown.id}) drawdown`));
  const before = (await snapshot()).rows[0];
  assert.ok(before && Object.values(before).every(Boolean));
  await setFeatures(f, { resourcing: false });
  await assert.rejects(upsertAssignment(assignmentInput(f, "2026-10-11")), refused("resourcing_feature_disabled"));
  await assert.rejects(createResourceRequest(requestInput(f, "2026-10-11")), refused("resource_requests_feature_disabled"));
  await assert.rejects(submitResourceRequest({ ...ctx(f), requestId: request.id }), refused("resource_requests_feature_disabled"));
  await assert.rejects(cancelResourceRequest({ ...ctx(f), requestId: request.id, reason: "cancel" }), refused("resource_requests_feature_disabled"));
  await assert.rejects(createTestRetainer(f), refused("retainer_billing_disabled"));
  await assert.rejects(draftHoursDrawdown({ ...ctx(f), retainerId: retainer.id, sunday: "2026-10-04" }), refused("retainer_billing_disabled"));
  assert.deepEqual((await snapshot()).rows[0], before);
  await setFeatures(f, KEYS);
  assert.deepEqual((await snapshot()).rows[0], before);
  assert.ok((await upsertAssignment(assignmentInput(f, "2026-10-11"))).assignment.id);
  assert.ok((await createResourceRequest(requestInput(f, "2026-10-11"))).id);
  assert.ok((await createTestRetainer(f)).id);
}));
