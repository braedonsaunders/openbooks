import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { env } from "@openbooks/engine/src/db.ts";

/**
 * Timesheet rejection audit: bouncing a submitted week back to the employee
 * is a material approval decision with a required reason, so it must leave
 * durable actor-attributed before/after evidence (including the reason) in
 * audit_log, in the same transaction as the status flip. A refused rejection
 * must leave no evidence behind.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __rejectRouteState: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (
      specifier.endsWith("/lib/feature-gates") &&
      context.parentURL?.includes("/api/timesheets/reject/")
    ) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function guardFeaturePermission(){
              return {
                user: globalThis.__rejectRouteState.user,
                permissions: new Set(['time.approve']),
                allowedSubsidiaryIds: null,
              };
            }
          `),
      };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { sql } = await import("drizzle-orm");
const { randomUUID } = await import("node:crypto");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);
const { POST } = await import("./reject/route.ts");

const post = (body: Record<string, unknown>) =>
  withOrgContext(state.user.orgId, () =>
    POST(
      new Request("http://audit.local/api/timesheets/reject", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );

async function seedSubmittedWeek() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  const employeeId = randomUUID();
  const headerId = randomUUID();
  const timeEntryId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into parties
        (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values
        (${employeeId}, ${org.orgId}, 'employee', 'Reject Worker',
         ${org.subsidiaryId}, true, '{}'::jsonb)
    `);
    await db.execute(sql`
      insert into timesheet_weeks
        (id, org_id, employee_party_id, week_start, status,
         submitted_by, submitted_at, created_by, updated_by)
      values
        (${headerId}, ${org.orgId}, ${employeeId}, '2026-07-12',
         'submitted', ${actorId}, now(), ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into time_entries
        (id, org_id, employee_party_id, worked_on, hours,
         status, is_billable, costing_basis, custom, created_by, updated_by)
      values
        (${timeEntryId}, ${org.orgId}, ${employeeId}, '2026-07-15',
         '4.0000', 'submitted', false, 'actual', '{}'::jsonb,
         ${actorId}, ${actorId})
    `);
  });
  return { org, actorId, employeeId, headerId, timeEntryId };
}

async function auditRows(orgId: string, headerId: string) {
  return withOrgContext(orgId, async () => (
    await db.execute(sql`
      select action, actor_id as "actorId", changes
        from audit_log
       where org_id = ${orgId}
         and table_name = 'timesheet_weeks'
         and row_id = ${headerId}
       order by at, id
    `)
  ).rows);
}

async function cleanup(fixture: Awaited<ReturnType<typeof seedSubmittedWeek>>) {
  await withBypassContext(async () => {
    await db.execute(sql`
      delete from time_entries where org_id = ${fixture.org.orgId}
    `);
  });
  await dropScratchOrg(fixture.org.orgId);
}

test(
  "rejecting a submitted week writes actor-attributed evidence including the reason",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const fixture = await seedSubmittedWeek();
    state.user = { orgId: fixture.org.orgId, id: fixture.actorId };
    try {
      const res = await post({
        employee: fixture.employeeId,
        week: "2026-07-12",
        reason: "Client code is wrong, please fix",
      });
      assert.equal(res.status, 200, await res.text());
      const rows = await auditRows(fixture.org.orgId, fixture.headerId);
      assert.equal(rows.length, 1, "rejection must leave exactly one audit row for the week");
      assert.equal(rows[0]!.action, "update");
      assert.equal(rows[0]!.actorId, fixture.actorId);
      const changes = rows[0]!.changes as {
        before: { status: string };
        after: { status: string };
        reason: string;
      };
      assert.equal(changes.before.status, "submitted");
      assert.equal(changes.after.status, "rejected");
      assert.equal(changes.reason, "Client code is wrong, please fix");
    } finally {
      await cleanup(fixture);
    }
  },
);

test(
  "a refused rejection leaves no audit evidence behind",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const fixture = await seedSubmittedWeek();
    state.user = { orgId: fixture.org.orgId, id: fixture.actorId };
    try {
      // No reason: the route refuses before any write.
      const res = await post({ employee: fixture.employeeId, week: "2026-07-12" });
      assert.equal(res.status, 422);
      const rows = await auditRows(fixture.org.orgId, fixture.headerId);
      assert.equal(rows.length, 0, "the refused rejection must not leave evidence");
    } finally {
      await cleanup(fixture);
    }
  },
);
