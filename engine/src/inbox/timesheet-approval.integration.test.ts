import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";
import { timesheetApprovalAdapter } from "./adapters/timesheet-approval.ts";
import type { InboxListContext } from "./types.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const WEEK = "2026-07-12";

async function fixture() {
  const org = await createScratchOrg();
  const supervisor = await createScratchUser(org.orgId, "Approver", "approver");
  const outsider = await createScratchUser(org.orgId, "Outsider", "outsider");
  await db.execute(sql`update app_roles set permissions='["time.approve"]'::jsonb where org_id=${org.orgId} and key='approver'`);
  await db.execute(sql`update app_roles set permissions='["time.read"]'::jsonb where org_id=${org.orgId} and key='outsider'`);
  await db.execute(sql`update orgs set settings = settings || '{"features": {"timeTracking": true}}'::jsonb where id=${org.orgId}`);
  const worker = randomUUID();
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${worker},${org.orgId},'person','Crew Hand',${org.subsidiaryId},true,'{}'::jsonb)`);
  const week = randomUUID();
  await db.execute(sql`insert into timesheet_weeks(id,org_id,employee_party_id,week_start,status,submitted_at)
    values (${week},${org.orgId},${worker},${WEEK}::date,'submitted',now())`);
  await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,status,is_billable,billing_status,costing_basis,created_by,updated_by)
    values (${org.orgId},${worker},'2026-07-14',8,'submitted',true,'unbilled','actual',${supervisor},${supervisor})`);
  const calls: { employeePartyId: string; weekStart: string }[] = [];
  const ctxFor = (actorId: string, withHook = true): InboxListContext => ({
    orgId: org.orgId,
    actorId,
    asOf: "2026-07-20",
    scope: { roles: [], allowedSubsidiaryIds: null },
    ...(withHook ? { approveTimesheetWeek: async (input: { employeePartyId: string; weekStart: string }) => { calls.push(input); } } : {}),
  });
  const close = async () => { await dropScratchOrgReporting(org.orgId); };
  return { org, supervisor, outsider, worker, week, ctxFor, calls, close };
}

test("gateless submitted weeks list for approvers with counts and lookup", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const ctx = f.ctxFor(f.supervisor);
    const items = await timesheetApprovalAdapter.list(ctx);
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.kind, "timesheet_approval");
    assert.match(item.title, /Crew Hand/);
    assert.match(item.title, new RegExp(WEEK));
    assert.match(item.subtitle ?? "", /8.*h/);
    assert.equal(item.subjectHref, `/timesheets?timesheet=${f.worker}:${WEEK}`);
    assert.deepEqual(item.actions.map((action) => action.key), ["approve"]);
    assert.equal(await timesheetApprovalAdapter.count!(ctx), 1);
    const found = await timesheetApprovalAdapter.lookup!(ctx, f.week);
    assert.equal(found?.id, item.id);
    assert.equal(await timesheetApprovalAdapter.lookup!(ctx, randomUUID()), null);
  } finally { await f.close(); }
});

test("weeks owned by a pending gate stay on the gate leg", { skip: !DB }, async () => {
  const f = await fixture();
  const flow = randomUUID();
  const run = randomUUID();
  try {
    await db.execute(sql`insert into flows(id,org_id,subject_kind,graph) values (${flow},${f.org.orgId},'timesheet_week','{}'::jsonb)`);
    await db.execute(sql`insert into flow_runs(id,org_id,flow_id,subject_kind,subject_id,trigger) values (${run},${f.org.orgId},${flow},'timesheet_week',${f.week},'submit')`);
    await db.execute(sql`insert into flow_gates(id,org_id,flow_id,run_id,node_id,subject_kind,subject_id,title,group_key,status) values (${randomUUID()},${f.org.orgId},${flow},${run},'approve','timesheet_week',${f.week},'Approve week','${run}:approve','pending')`);
    const ctx = f.ctxFor(f.supervisor);
    assert.deepEqual(await timesheetApprovalAdapter.list(ctx), []);
    assert.equal(await timesheetApprovalAdapter.count!(ctx), 0);
    assert.equal(await timesheetApprovalAdapter.lookup!(ctx, f.week), null);
  } finally { await f.close(); }
});

test("act approves through the wired native command and nothing else", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const ctx = f.ctxFor(f.supervisor);
    const item = (await timesheetApprovalAdapter.list(ctx))[0]!;
    await timesheetApprovalAdapter.act(ctx, item.source.id, "approve");
    assert.deepEqual(f.calls, [{ employeePartyId: f.worker, weekStart: WEEK }]);
    await assert.rejects(
      timesheetApprovalAdapter.act(ctx, item.source.id, "reject"),
      /not available here/,
    );
    const unwired = f.ctxFor(f.supervisor, false);
    await assert.rejects(timesheetApprovalAdapter.act(unwired, item.source.id, "approve"), /not wired/);
  } finally { await f.close(); }
});

test("without the approve grant there is no direct leg", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const ctx = f.ctxFor(f.outsider);
    assert.deepEqual(await timesheetApprovalAdapter.list(ctx), []);
    assert.equal(await timesheetApprovalAdapter.count!(ctx), 0);
  } finally { await f.close(); }
});
