import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import type { SessionUser } from "../../../../lib/auth";

/** Inbox decisions use the same configured Flow gates as the timesheet workspace. */
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __inboxDirectApprove: session });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts"))
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__inboxDirectApprove.user}",
      };
    return next(specifier, context);
  },
});
const { sql } = await import("drizzle-orm");
const { db, withOrgContext, withOrgTransaction } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting, seedApprovalFlow } =
  await import("@openbooks/engine/testing/fixtures");
const { routeSubjectSubmission } = await import("@openbooks/engine/flows/submission-policy");
const { registerFlowApprovalReleaseHandlers } =
  await import("../../../../lib/flow-approval-releases");
await registerFlowApprovalReleaseHandlers();
const { POST } = await import("./route");

const WEEK = "2026-07-12";

async function fixture() {
  const org = await createScratchOrg();
  const supervisor = await createScratchUser(org.orgId, "Approver", "approver");
  await db.execute(
    sql`update app_roles set permissions='["time.read","time.manage","time.approve"]'::jsonb where org_id=${org.orgId} and key='approver'`,
  );
  await db.execute(
    sql`update orgs set settings = settings || ${JSON.stringify({
      features: { projects: false, timeTracking: true },
      timesheets: { requireApproval: true },
    })}::jsonb where id=${org.orgId}`,
  );
  const worker = randomUUID();
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${worker},${org.orgId},'employee','Crew Hand',${org.subsidiaryId},true,'{}'::jsonb)`);
  await db.execute(
    sql`insert into employee_roles(id,org_id,party_id,is_active) values (${randomUUID()},${org.orgId},${worker},true)`,
  );
  const week = randomUUID();
  await db.execute(sql`insert into timesheet_weeks(id,org_id,employee_party_id,week_start,status,submitted_at)
    values (${week},${org.orgId},${worker},${WEEK}::date,'submitted',now())`);
  await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,status,is_billable,billing_status,costing_basis,created_by,updated_by)
    values (${org.orgId},${worker},'2026-07-14',8,'submitted',false,'unbilled','actual',${supervisor},${supervisor})`);
  await seedApprovalFlow(org.orgId, {
    subjectKind: "timesheet_week",
    mode: "any",
    preventSelfApproval: false,
    assignees: [{ type: "user", userId: supervisor }],
  });
  await withOrgTransaction(org.orgId, () =>
    routeSubjectSubmission({
      orgId: org.orgId,
      actorId: supervisor,
      subjectKind: "timesheet_week",
      subjectId: week,
    }),
  );
  const gate = (
    await db.execute<{ id: string }>(
      sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${week} and status='pending'`,
      "objects",
    )
  )[0]!;
  session.user = {
    id: supervisor,
    orgId: org.orgId,
    name: "Approver",
    email: "approver@example.test",
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: org.orgId,
    homeOrgId: org.orgId,
    homeUserId: supervisor,
  };
  const act = (itemId: string, actionKey: string) =>
    withOrgContext(org.orgId, () =>
      POST(
        new Request("http://time.local/api/inbox/act", {
          method: "POST",
          body: JSON.stringify({ itemId, actionKey }),
        }),
      ),
    );
  const status = async () =>
    (
      await db.execute<{ status: string }>(
        sql`
    select status from time_entries where org_id=${org.orgId} and employee_party_id=${worker}`,
        "objects",
      )
    ).map((row) => row.status);
  const close = async () => {
    session.user = null;
    await dropScratchOrgReporting(org.orgId);
  };
  return { org, supervisor, worker, week, gateId: gate.id, act, status, close };
}

test("a submitted week approves through its tenant Flow gate from the inbox", async () => {
  const f = await fixture();
  try {
    const response = await f.act(`timesheet_week:gate:${f.gateId}`, "approve");
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(await f.status(), ["approved"]);
  } finally {
    await f.close();
  }
});

test("unknown actions and missing weeks refuse without a leak", async () => {
  const f = await fixture();
  try {
    const unknown = await f.act(`timesheet_week:gate:${f.gateId}`, "unknown-action");
    assert.equal(unknown.status, 422);
    const missing = await f.act(`timesheet_week:gate:${randomUUID()}`, "approve");
    assert.equal(missing.status, 404);
    assert.deepEqual(await f.status(), ["submitted"], "refused acts write nothing");
  } finally {
    await f.close();
  }
});
