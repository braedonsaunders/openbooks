import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { NextResponse } from "next/server";

/**
 * Live-Postgres regression for concurrent bank-rule edits. The PATCH handler
 * must lock the rule before reading the audit before-image; otherwise two
 * writers can both snapshot A, serialize their UPDATEs behind a holder, and
 * leave an impossible audit history (A→B, A→C). The authorization seam is
 * mocked, but both mutations, row locks, and audit inserts use the production
 * route and database.
 */
const stateKey = Symbol.for("openbooks.banking-rules-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
  deny(permission: string | null): NextResponse;
}
const routeState: RouteState = {
  authz: null,
  deny(permission) {
    return permission
      ? NextResponse.json({ error: `missing permission: ${permission}` }, { status: 403 })
      : NextResponse.json({ error: "unauthorized" }, { status: 401 });
  },
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.banking-rules-route-test')]
  export async function guardPermission(permission) {
    if (!state.authz) return state.deny(null)
    if (!state.authz.permissions.has('*') && !state.authz.permissions.has(permission)) {
      return state.deny(permission)
    }
    return state.authz
  }
  export async function getAuthz() {
    return state.authz
  }
  export function guardUnrestrictedScope(authz) {
    return authz.allowedSubsidiaryIds === null ? null : state.deny('unrestricted scope required')
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // feature-gates imports this relative authz module; keep that one seam
    // mocked while loading the real route and validation implementation.
    if (
      specifier === "./authz" &&
      (context.parentURL?.includes("/lib/feature-gates") ||
        context.parentURL?.includes("/lib/super-admin"))
    ) {
      return { url: "mock:banking-rules-authz", shortCircuit: true };
    }
    if (
      specifier === "../../../../../lib/authz" &&
      context.parentURL?.includes("/banking/rules/[id]/route")
    ) {
      return { url: "mock:banking-rules-authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:banking-rules-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?banking-rules-concurrency-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
const deleteRouteUrl = "./[id]/route.ts?banking-rules-delete-test";
const { DELETE } = (await import(deleteRouteUrl)) as typeof import("./[id]/route.ts");

const { db, withBypass, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");

type RuleSnapshot = {
  name: string;
  criteria: Record<string, unknown>;
  outcome: Record<string, unknown>;
  priority: number;
};

interface Fixture {
  orgId: string;
  actorId: string;
  ruleId: string;
}

function criteria(needle: string): Record<string, unknown> {
  return {
    version: 2,
    match: {
      combinator: "and",
      rules: [{ field: "description", op: "contains", value: needle }],
    },
  };
}

async function seed(): Promise<Fixture> {
  return withBypass(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Bank Rules Admin", "bank_rules_admin");
    const ruleId = randomUUID();
    await db.execute(sql`
      insert into bank_match_rules
        (id, org_id, name, criteria, outcome, priority, is_active, created_by, updated_by)
      values
        (${ruleId}, ${org.orgId}, 'Initial Rule', ${JSON.stringify(criteria("initial"))}::jsonb,
         '{"action":"exclude"}'::jsonb, 100, true, ${actorId}, ${actorId})`);
    return { orgId: org.orgId, actorId, ruleId };
  });
}

function authorize(fixture: Fixture): void {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    permissions: new Set(["banking.reconcile"]),
    allowedSubsidiaryIds: null,
  };
}

function patchRequest(body: unknown): Request {
  return new Request("http://openbooks.test/api/banking/rules", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(fixture: Fixture, body: RuleSnapshot): Promise<Response> {
  return withOrgContext(fixture.orgId, () => PATCH(patchRequest({ id: fixture.ruleId, ...body })));
}

async function ruleState(fixture: Fixture): Promise<RuleSnapshot> {
  return withOrgContext(fixture.orgId, async () => {
    const result = await db.execute<RuleSnapshot>(
      sql`
      select name, criteria, outcome, priority
        from bank_match_rules
       where id = ${fixture.ruleId} and org_id = ${fixture.orgId}`,
      "objects",
    );
    assert.ok(result[0], "the seeded banking rule must exist");
    return result[0]!;
  });
}

async function auditUpdates(
  fixture: Fixture,
): Promise<{ before: RuleSnapshot; after: RuleSnapshot }[]> {
  return withOrgContext(fixture.orgId, async () => {
    const result = await db.execute<{
      before: RuleSnapshot;
      after: RuleSnapshot;
    }>(
      sql`
      select changes->'before' as before, changes->'after' as after
        from audit_log
       where org_id = ${fixture.orgId}
         and table_name = 'bank_match_rules'
         and row_id = ${fixture.ruleId}
         and action = 'update'
       order by id`,
      "objects",
    );
    return result;
  });
}

async function deleteRule(fixture: Fixture): Promise<Response> {
  return withOrgContext(fixture.orgId, () =>
    DELETE(
      new Request(`http://openbooks.test/api/banking/rules/${fixture.ruleId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: fixture.ruleId }) },
    ),
  );
}

/**
 * Wait until route transactions are visibly queued behind the holder. A PATCH
 * takes the rule-set advisory lock before the rule row lock, so the first
 * writer queues on the row and a later writer queues on the advisory lock
 * behind it. A waiter counts only when it is blocked by the holder or by
 * another queued rule writer, so unrelated sessions in the shared database
 * cannot satisfy the wait.
 */
async function waitForRuleWriters(holderPid: number, expected: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await db.execute<{ count: number }>(
      sql`
      with queued as (
        select pid, pg_blocking_pids(pid) as blockers
          from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and wait_event_type = 'Lock'
           and (query ilike '%bank_match_rules%' or query ilike '%pg_advisory_xact_lock%')
      ),
      blockers_in_chain as (
        select pid from queued
        union all
        select ${holderPid}::int
      )
      select count(*)::int as count
        from queued
       where blockers && array(select pid from blockers_in_chain)`,
      "objects",
    );
    if ((result[0]?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`expected ${expected} banking-rule writers to queue behind the rule edit`);
}

test("concurrent PATCH requests chain bank-rule audit before-images from committed edits", async () => {
  const fixture = await seed();
  const holder = new Client({
    connectionString: process.env.OPENBOOKS_DB_URL,
  });
  let holderOpen = false;
  try {
    authorize(fixture);
    await holder.connect();
    holderOpen = true;
    const holderPid = Number(
      (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid,
    );
    await holder.query("begin");
    await holder.query(
      "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)",
      [fixture.orgId],
    );
    await holder.query("select id from bank_match_rules where id = $1 and org_id = $2 for update", [
      fixture.ruleId,
      fixture.orgId,
    ]);

    const firstEdit: RuleSnapshot = {
      name: "First Edit",
      criteria: criteria("first"),
      outcome: { action: "exclude" },
      priority: 110,
    };
    const secondEdit: RuleSnapshot = {
      name: "Second Edit",
      criteria: criteria("second"),
      outcome: { action: "exclude" },
      priority: 120,
    };
    const firstWrite = patch(fixture, firstEdit);
    await waitForRuleWriters(holderPid, 1);
    const secondWrite = patch(fixture, secondEdit);
    await waitForRuleWriters(holderPid, 2);

    await holder.query("commit");
    await holder.end();
    holderOpen = false;
    const responses = await Promise.all([firstWrite, secondWrite]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );

    const audits = await auditUpdates(fixture);
    assert.equal(audits.length, 2, "both committed edits need one audit row");
    const initialToFirst = audits.find((audit) => audit.before.name === "Initial Rule");
    assert.ok(initialToFirst, "one edit must preserve the initial before-image");
    const chained = audits.find(
      (audit) =>
        audit.before.name === initialToFirst.after.name && audit.before.name !== "Initial Rule",
    );
    assert.ok(
      chained,
      "the second edit must snapshot the first committed configuration, not the stale initial row",
    );
    assert.deepEqual(
      new Set(audits.map((audit) => audit.after.name)),
      new Set([firstEdit.name, secondEdit.name]),
    );
    const final = await ruleState(fixture);
    assert.ok(
      final.name === firstEdit.name || final.name === secondEdit.name,
      "the serialized writer must leave one committed edit as the current rule",
    );
  } finally {
    routeState.authz = null;
    if (holderOpen) {
      await holder.query("rollback").catch(() => {});
      await holder.end().catch(() => {});
    }
    await dropScratchOrg(fixture.orgId);
  }
});

test("concurrent DELETE requests return one success and write one delete audit", async () => {
  const fixture = await seed();
  try {
    authorize(fixture);
    const responses = await Promise.all([deleteRule(fixture), deleteRule(fixture)]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 404]);
    const audits = await withOrgContext(fixture.orgId, () =>
      db.execute<{ count: number }>(
        sql`
        select count(*)::int as count from audit_log
         where org_id = ${fixture.orgId} and table_name = 'bank_match_rules'
           and row_id = ${fixture.ruleId} and action = 'delete'
      `,
        "objects",
      ),
    );
    assert.equal(audits[0]?.count, 1);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(fixture.orgId);
  }
});

// Release the route doubles after every test in this file has run.
test.after(() => hooks.deregister());
