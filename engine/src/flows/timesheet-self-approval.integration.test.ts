import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  seedApprovalFlow,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";
import { routeSubjectSubmission } from "./submission-policy.ts";
import { FlowDispatchError } from "./dispatch-result.ts";
import { gateDecisionCapability } from "./gates.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const WEEK = "2026-07-12";

/** Timesheet decisions obey the tenant's frozen self-approval policy. */
async function fixture() {
  const org = await createScratchOrg();
  const submitter = await createScratchUser(org.orgId, "Entering administrator", "admin");
  const worker = randomUUID();
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${worker},${org.orgId},'employee','Crew Hand',${org.subsidiaryId},true,'{}'::jsonb)`);
  await db.execute(
    sql`insert into employee_roles(id,org_id,party_id,is_active) values (${randomUUID()},${org.orgId},${worker},true)`,
  );
  const week = randomUUID();
  await db.execute(sql`insert into timesheet_weeks(id,org_id,employee_party_id,week_start,status,submitted_by,submitted_at,created_by,updated_by)
    values (${week},${org.orgId},${worker},${WEEK}::date,'submitted',${submitter},now(),${submitter},${submitter})`);
  await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,status,is_billable,billing_status,costing_basis,created_by,updated_by)
    values (${org.orgId},${worker},'2026-07-14',8,'submitted',false,'unbilled','actual',${submitter},${submitter})`);
  const close = async () => {
    await dropScratchOrgReporting(org.orgId);
  };
  return { org, submitter, worker, week, close };
}

for (const preventSelfApproval of [true, false]) {
  test(
    `timesheet decision eligibility follows the tenant policy: ${preventSelfApproval ? "restricted" : "allowed"}`,
    { skip: !DB },
    async () => {
      const f = await fixture();
      try {
        await seedApprovalFlow(f.org.orgId, {
          subjectKind: "timesheet_week",
          mode: "all",
          preventSelfApproval,
          assignees: [{ type: "user", userId: f.submitter }],
        });
        const submit = () =>
          withOrgTransaction(f.org.orgId, () =>
            routeSubjectSubmission({
              orgId: f.org.orgId,
              actorId: f.submitter,
              subjectKind: "timesheet_week",
              subjectId: f.week,
            }),
          );
        if (preventSelfApproval) {
          await assert.rejects(
            submit(),
            (error) => error instanceof FlowDispatchError && /zero assignees/.test(error.message),
          );
          assert.equal(
            (
              await db.execute(
                sql`select id from flow_gates where org_id=${f.org.orgId} and subject_id=${f.week}`,
                "objects",
              )
            ).length,
            0,
          );
          assert.equal(
            (
              await db.execute(
                sql`select id from flow_submissions where org_id=${f.org.orgId} and subject_id=${f.week}`,
                "objects",
              )
            ).length,
            0,
          );
        } else {
          assert.equal((await submit()).policy.kind, "gated");
          const gate = (
            await db.execute<{ id: string }>(
              sql`select id from flow_gates where org_id=${f.org.orgId}
          and subject_id=${f.week} and assignee_user_id=${f.submitter} and status='pending'`,
              "objects",
            )
          )[0];
          assert.ok(gate);
          const capability = await withOrgTransaction(f.org.orgId, () =>
            gateDecisionCapability(gate.id, f.submitter),
          );
          assert.equal(capability.canAct, true);
          assert.equal(capability.sodBlocked, false);
        }
      } finally {
        await f.close();
      }
    },
  );
}
