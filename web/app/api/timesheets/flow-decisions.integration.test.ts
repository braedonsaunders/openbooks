import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import type { SessionUser } from "../../../lib/auth";

/** Tenant Flow gates alone determine separation for weekly timesheets. */
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __selfApprove: session });
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
        url: "data:text/javascript,export async function currentUser(){return globalThis.__selfApprove.user}",
      };
    return next(specifier, context);
  },
});
const { sql } = await import("drizzle-orm");
const { db, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } =
  await import("@openbooks/engine/testing/fixtures");
const { configureTimesheetReviewFixture, decideTimesheetFixture } =
  await import("../../../testing/timesheet-flows");
const { POST: submitWeek } = await import("./submit/route");
const { PUT } = await import("./route");
const { loadWeek } = await import("./_lib");

const WEEK = "2026-07-12";

async function employeeParty(orgId: string, subsidiaryId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
    values (${id},${orgId},'employee',${name},${subsidiaryId},true,'{}'::jsonb)`);
  await db.execute(
    sql`insert into employee_roles(id,org_id,party_id,is_active) values (${randomUUID()},${orgId},${id},true)`,
  );
  return id;
}

async function fixture(gated: boolean, preventSelfApproval = false) {
  const org = await createScratchOrg();
  const supervisor = await createScratchUser(org.orgId, "Approver", "approver");
  await db.execute(
    sql`update app_roles set permissions='["time.read","time.manage","time.approve"]'::jsonb where org_id=${org.orgId} and key='approver'`,
  );
  await db.execute(
    sql`update orgs set settings = settings || ${JSON.stringify({
      features: { projects: false, timeTracking: true },
    })}::jsonb where id=${org.orgId}`,
  );
  // The approver is also a timekeeper: their login links to their own
  // employee party, exactly like a working supervisor's does.
  const ownParty = await employeeParty(org.orgId, org.subsidiaryId, "Approver Self");
  await db.execute(
    sql`update users set party_id=${ownParty} where id=${supervisor} and org_id=${org.orgId}`,
  );
  const coworker = await employeeParty(org.orgId, org.subsidiaryId, "Crew One");
  const asUser = (userId: string, name: string) => {
    session.user = {
      id: userId,
      orgId: org.orgId,
      name,
      email: `${userId.slice(0, 8)}@example.test`,
      roles: [],
      isSuperAdmin: false,
      envKind: "production",
      productionOrgId: org.orgId,
      homeOrgId: org.orgId,
      homeUserId: userId,
    };
  };
  asUser(supervisor, "Approver");
  const save = async (employee: string) => {
    const expectedRevision = (
      await withOrgContext(org.orgId, () => loadWeek(org.orgId, employee, WEEK))
    ).revision;
    return withOrgContext(org.orgId, () =>
      PUT(
        new Request("http://time.local/api/timesheets", {
          method: "PUT",
          body: JSON.stringify({
            employee,
            week: WEEK,
            rows: [
              {
                projectId: null,
                itemId: org.items.service,
                isBillable: false,
                hours: ["", "", "", "8", "", "", ""],
              },
            ],
            expectedRevision,
          }),
        }),
      ),
    );
  };
  const submit = (employee: string) =>
    withOrgContext(org.orgId, () =>
      submitWeek(
        new Request("http://time.local/api/timesheets/submit", {
          method: "POST",
          body: JSON.stringify({ employee, week: WEEK }),
        }),
      ),
    );
  const approve = (employee: string) =>
    withOrgContext(org.orgId, () =>
      decideTimesheetFixture({ orgId: org.orgId, employee, week: WEEK, decision: "approved" }),
    );
  const entryStatuses = async () =>
    (
      await db.execute<{ status: string }>(
        sql`
    select status from time_entries where org_id=${org.orgId} and employee_party_id=${ownParty}`,
        "objects",
      )
    ).map((row) => row.status);
  if (gated) await configureTimesheetReviewFixture(org.orgId, supervisor, preventSelfApproval);
  const close = async () => {
    session.user = null;
    await dropScratchOrgReporting(org.orgId);
  };
  return {
    org,
    supervisor,
    ownParty,
    coworker,
    asUser,
    save,
    submit,
    approve,
    entryStatuses,
    close,
  };
}

test(
  "a tenant without approval gates releases its own submitted hours without another person",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await fixture(false);
    try {
      assert.equal((await f.save(f.ownParty)).status, 200);
      const response = await f.submit(f.ownParty);
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await f.entryStatuses(), ["approved"]);
      const receipt = await db.execute<{ kind: string }>(
        sql`select policy->>'kind' as kind from flow_submissions where org_id=${f.org.orgId} and subject_kind='timesheet_week'`,
        "objects",
      );
      assert.deepEqual(receipt, [{ kind: "ungated" }]);
    } finally {
      await f.close();
    }
  },
);

test(
  "a tenant may permit the worker and time author to decide their own assigned gate",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await fixture(true, false);
    try {
      assert.equal((await f.save(f.ownParty)).status, 200);
      assert.equal((await f.submit(f.ownParty)).status, 200);
      assert.deepEqual(await f.entryStatuses(), ["submitted"]);
      const response = await f.approve(f.ownParty);
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await f.entryStatuses(), ["approved"]);
    } finally {
      await f.close();
    }
  },
);

test(
  "a configured gate with no eligible assignee refuses submission and leaves no approval or release",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await fixture(true, true);
    try {
      assert.equal((await f.save(f.ownParty)).status, 200);
      const response = await f.submit(f.ownParty);
      assert.equal(response.status, 422, await response.clone().text());
      assert.match(await response.text(), /zero assignees|workflow|Flow/i);
      assert.deepEqual(await f.entryStatuses(), ["draft"]);
      assert.equal(
        (
          await db.execute(
            sql`select id from flow_gates where org_id=${f.org.orgId} and status='pending'`,
            "objects",
          )
        ).length,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "the shared Flow rejection preserves actor, reason, header and entry evidence atomically",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await fixture(true, false);
    try {
      assert.equal((await f.save(f.ownParty)).status, 200);
      assert.equal((await f.submit(f.ownParty)).status, 200);
      const missing = await withOrgContext(f.org.orgId, () =>
        decideTimesheetFixture({
          orgId: f.org.orgId,
          employee: f.ownParty,
          week: WEEK,
          decision: "rejected",
        }),
      );
      assert.equal(missing.status, 422, await missing.clone().text());
      assert.deepEqual(await f.entryStatuses(), ["submitted"]);
      const reason = "Correct the recorded hours before this week can be released";
      const response = await withOrgContext(f.org.orgId, () =>
        decideTimesheetFixture({
          orgId: f.org.orgId,
          employee: f.ownParty,
          week: WEEK,
          decision: "rejected",
          reason,
        }),
      );
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await f.entryStatuses(), ["rejected"]);
      const audit = await db.execute<{
        actor_id: string;
        changes: { reason: string; before: { status: string }; after: { status: string } };
      }>(
        sql`select actor_id,changes from audit_log where org_id=${f.org.orgId} and table_name='timesheet_weeks' and changes->>'event'='rejected'`,
        "objects",
      );
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.actor_id, f.supervisor);
      assert.equal(audit[0]?.changes.reason, reason);
      assert.equal(audit[0]?.changes.before.status, "submitted");
      assert.equal(audit[0]?.changes.after.status, "rejected");
      const repeated = await withOrgContext(f.org.orgId, () =>
        decideTimesheetFixture({
          orgId: f.org.orgId,
          employee: f.ownParty,
          week: WEEK,
          decision: "rejected",
          reason,
        }),
      );
      assert.equal(repeated.status, 404, "a consumed gate cannot reject or audit twice");
    } finally {
      await f.close();
    }
  },
);

test(
  "a native timesheet gate cannot be decided after current legal-entity access is revoked",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await fixture(true, false);
    try {
      assert.equal((await f.save(f.ownParty)).status, 200);
      assert.equal((await f.submit(f.ownParty)).status, 200);
      await db.execute(
        sql`update app_roles set subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb where org_id=${f.org.orgId} and key='approver'`,
      );
      const response = await f.approve(f.ownParty);
      assert.ok([403, 404].includes(response.status), await response.clone().text());
      assert.deepEqual(await f.entryStatuses(), ["submitted"]);
      assert.equal(
        (
          await db.execute(
            sql`select id from flow_gates where org_id=${f.org.orgId} and status='pending'`,
            "objects",
          )
        ).length,
        1,
      );
    } finally {
      await f.close();
    }
  },
);
