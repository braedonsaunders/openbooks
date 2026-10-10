import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * Timesheet withdraw: recalling a submitted week returns it to draft and
 * cancels its open approval runs through the native Flow path, with
 * actor-attributed before/after evidence in the same transaction. Decided
 * weeks stay decided, and a refused recall leaves no evidence behind.
 */
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __withdrawRouteState: state });
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.endsWith("/lib/feature-gates") &&
      (context.parentURL?.includes("/api/timesheets/withdraw/") ||
        context.parentURL?.includes("/web/lib/api/route.ts"))
    ) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function guardFeaturePermission(){
              return {
                user: globalThis.__withdrawRouteState.user,
                permissions: new Set(['time.manage']),
                allowedSubsidiaryIds: null,
              };
            }
          `),
      };
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { randomUUID } = await import("node:crypto");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { POST } = await import("./withdraw/route.ts");

const post = (body: Record<string, unknown>) =>
  withOrgContext(state.user.orgId, () =>
    POST(
      new Request("http://audit.local/api/timesheets/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );

async function seedSubmittedWeek(status: "submitted" | "approved" | "draft" = "submitted") {
  const org = await withBypassContext(() => createScratchOrg());
  const actors = await withBypassContext(() => seedFlowActors(org.orgId));
  const actorId = actors.adminId;
  const employeeId = randomUUID();
  const headerId = randomUUID();
  const timeEntryId = randomUUID();
  const flowId = randomUUID();
  const runId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into parties
        (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values
        (${employeeId}, ${org.orgId}, 'employee', 'Withdraw Worker',
         ${org.subsidiaryId}, true, '{}'::jsonb)
    `);
    // Link the caller to the employee as production self-service does; the
    // own-week versus coworker matrix itself is proven in
    // self-scope.integration.test.ts through real roles.
    await db.execute(sql`
      update users set party_id = ${employeeId} where id = ${actorId} and org_id = ${org.orgId}
    `);
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id, is_active)
      values (${randomUUID()}, ${org.orgId}, ${employeeId}, true)
    `);
    await db.execute(sql`
      insert into timesheet_weeks
        (id, org_id, employee_party_id, week_start, status,
         created_by, updated_by)
      values
        (${headerId}, ${org.orgId}, ${employeeId}, '2026-07-12',
         ${status}, ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into time_entries
        (id, org_id, employee_party_id, worked_on, hours,
         status, approved_by, approved_at, is_billable, costing_basis,
         custom, created_by, updated_by)
      values
        (${timeEntryId}, ${org.orgId}, ${employeeId}, '2026-07-15',
         '4.0000', ${status === "draft" ? "draft" : status}, null, null, false, 'actual',
         '{}'::jsonb, ${actorId}, ${actorId})
    `);
    if (status === "submitted") {
      await db.execute(sql`
        insert into flows (id, org_id, subject_kind, graph)
        values (${flowId}, ${org.orgId}, 'timesheet_week', '{}'::jsonb)
      `);
      await db.execute(sql`
        insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger, status)
        values (${runId}, ${org.orgId}, ${flowId}, 'timesheet_week', ${headerId}, 'on_submit', 'waiting')
      `);
      await db.execute(sql`
        insert into flow_gates (id, org_id, flow_id, run_id, node_id, subject_kind, subject_id, title, group_key, status)
        values (${randomUUID()}, ${org.orgId}, ${flowId}, ${runId}, 'approve', 'timesheet_week', ${headerId}, 'Approve week', ${`${runId}:approve`}, 'pending')
      `);
    }
  });
  return { org, actorId, employeeId, headerId, timeEntryId, runId };
}

async function weekStatus(orgId: string, headerId: string) {
  return withOrgContext(orgId, async () => (
    await db.execute<{ status: string }>(sql`
      select status from timesheet_weeks where org_id = ${orgId} and id = ${headerId}
    `)
  ).rows[0]!.status);
}

async function entryStatus(orgId: string, timeEntryId: string) {
  return withOrgContext(orgId, async () => (
    await db.execute<{ status: string }>(sql`
      select status from time_entries where org_id = ${orgId} and id = ${timeEntryId}
    `)
  ).rows[0]!.status);
}

async function runState(orgId: string, runId: string) {
  return withOrgContext(orgId, async () => ({
    run: (await db.execute<{ status: string }>(sql`
      select status from flow_runs where org_id = ${orgId} and id = ${runId}
    `)).rows[0]!.status,
    gate: (await db.execute<{ status: string }>(sql`
      select status from flow_gates where org_id = ${orgId} and run_id = ${runId}
    `)).rows[0]!.status,
  }));
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
  "withdrawing a submitted week returns it to draft and cancels its approval run",
  async () => {
    const fixture = await seedSubmittedWeek();
    state.user = { orgId: fixture.org.orgId, id: fixture.actorId };
    try {
      const res = await post({ employee: fixture.employeeId, week: "2026-07-12" });
      assert.equal(res.status, 200, await res.text());
      assert.equal(await weekStatus(fixture.org.orgId, fixture.headerId), "draft");
      assert.equal(await entryStatus(fixture.org.orgId, fixture.timeEntryId), "draft");
      const gated = await runState(fixture.org.orgId, fixture.runId);
      assert.equal(gated.gate, "cancelled", "the pending gate dies with the recall");
      assert.equal(gated.run, "cancelled", "the waiting run dies with the recall");
      const rows = await auditRows(fixture.org.orgId, fixture.headerId);
      assert.equal(rows.length, 1, "the recall leaves exactly one audit row for the week");
      const changes = rows[0]!.changes as {
        event: string;
        before: { status: string };
        after: { status: string };
        cancelledRuns: string[];
      };
      assert.equal(changes.event, "withdrawn");
      assert.equal(changes.before.status, "submitted");
      assert.equal(changes.after.status, "draft");
      assert.deepEqual(changes.cancelledRuns, [fixture.runId]);
    } finally {
      await cleanup(fixture);
    }
  },
);

test(
  "concurrent withdrawals serialize: exactly one recalls and audits",
  async () => {
    const fixture = await seedSubmittedWeek();
    state.user = { orgId: fixture.org.orgId, id: fixture.actorId };
    try {
      const [first, second] = await Promise.all([
        post({ employee: fixture.employeeId, week: "2026-07-12" }),
        post({ employee: fixture.employeeId, week: "2026-07-12" }),
      ]);
      const statuses = [first.status, second.status].sort();
      assert.deepEqual(statuses, [200, 422], "the replay loser must be refused under the header lock");
      const rows = await auditRows(fixture.org.orgId, fixture.headerId);
      assert.equal(rows.length, 1, "the loser must not write a second 'withdrawn' audit");
    } finally {
      await cleanup(fixture);
    }
  },
);

test(
  "decided and empty weeks refuse withdrawal with no evidence",
  async () => {
    const decided = await seedSubmittedWeek("approved");
    state.user = { orgId: decided.org.orgId, id: decided.actorId };
    try {
      const res = await post({ employee: decided.employeeId, week: "2026-07-12" });
      assert.equal(res.status, 422, "an approved week is decided, not recallable");
      assert.match(((await res.json()) as { error: string }).error, /already decided/);
      assert.equal((await auditRows(decided.org.orgId, decided.headerId)).length, 0);
    } finally {
      await cleanup(decided);
    }

    const empty = await seedSubmittedWeek("draft");
    state.user = { orgId: empty.org.orgId, id: empty.actorId };
    try {
      const res = await post({ employee: empty.employeeId, week: "2026-07-12" });
      assert.equal(res.status, 422, "a draft week has nothing to recall");
      assert.equal((await auditRows(empty.org.orgId, empty.headerId)).length, 0);
    } finally {
      await cleanup(empty);
    }
  },
);
