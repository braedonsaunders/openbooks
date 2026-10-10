import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";
import { decideGate, GateError } from "./gates.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const WEEK = "2026-07-12";

/**
 * Separation of duties on timesheet gates: the user who entered or
 * submitted the week cannot decide its gate. The refusal is typed
 * (self_approval_forbidden) with timesheet wording; every other subject
 * keeps the generic text.
 */
async function fixture() {
  const org = await createScratchOrg();
  const submitter = await createScratchUser(org.orgId, "Bookkeeper", "bookkeeper");
  const worker = randomUUID();
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${worker},${org.orgId},'employee','Crew Hand',${org.subsidiaryId},true,'{}'::jsonb)`);
  await db.execute(sql`insert into employee_roles(id,org_id,party_id,is_active) values (${randomUUID()},${org.orgId},${worker},true)`);
  const week = randomUUID();
  await db.execute(sql`insert into timesheet_weeks(id,org_id,employee_party_id,week_start,status,submitted_by,submitted_at,created_by,updated_by)
    values (${week},${org.orgId},${worker},${WEEK}::date,'submitted',${submitter},now(),${submitter},${submitter})`);
  await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,status,is_billable,billing_status,costing_basis,created_by,updated_by)
    values (${org.orgId},${worker},'2026-07-14',8,'submitted',false,'unbilled','actual',${submitter},${submitter})`);
  const flow = randomUUID();
  const run = randomUUID();
  const gate = randomUUID();
  await db.execute(sql`insert into flows(id,org_id,subject_kind,graph) values (${flow},${org.orgId},'timesheet_week','{}'::jsonb)`);
  await db.execute(sql`insert into flow_runs(id,org_id,flow_id,subject_kind,subject_id,trigger) values (${run},${org.orgId},${flow},'timesheet_week',${week},'submit')`);
  await db.execute(sql`insert into flow_gates(id,org_id,flow_id,run_id,node_id,subject_kind,subject_id,title,group_key,status,assignee_user_id) values (${gate},${org.orgId},${flow},${run},'approve','timesheet_week',${week},'Approve week','${run}:approve','pending',${submitter})`);
  const close = async () => { await dropScratchOrgReporting(org.orgId); };
  return { org, submitter, worker, week, gate, close };
}

test("the entering user cannot decide their own timesheet gate", { skip: !DB }, async () => {
  const f = await fixture();
  try {
    const error = await decideGate({ gateId: f.gate, decision: "approved", userId: f.submitter, allowedSubsidiaryIds: null }).then(
      () => { throw new Error("expected a refusal"); },
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof GateError);
    assert.equal((error as GateError).code, "self_approval_forbidden");
    assert.equal((error as Error).message, "You entered this timesheet; another approver must approve it.");
    const status = (await db.execute<{ status: string }>(sql`
      select status from flow_gates where org_id=${f.org.orgId} and id=${f.gate}`)).rows[0]?.status;
    assert.equal(status, "pending", "the refused decision records nothing");
  } finally { await f.close(); }
});
