import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for the overhead setup boundary. set-application
// used to persist any UUID as the net-zero pair's ledger posting account, so
// a typo stored a dangling account id whose failure only surfaced later at
// time-approval posting; set-lifecycle and set-application also wrote
// settings and audit_log as two autocommit statements, so a failure past the
// settings write committed an unevidenced policy change. These tests prove
// strict account validation and all-or-nothing evidenced writes against real
// PostgreSQL. Only the authorization seam is a test double.
const stateKey = Symbol.for("openbooks.overhead-route-test");
const routeState = { gate: null as null | { user: { orgId: string; id: string } } };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.overhead-route-test')]
  export async function guardPermission() { return state.gate }
  export function can() { return true }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../../../lib/authz" && context.parentURL?.includes("setup/overhead/route")) {
      return { shortCircuit: true, url: "mock:overhead-authz" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:overhead-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypassContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

async function storedApplication(orgId: string): Promise<unknown> {
  const r = await withBypassContext(() => db.execute(sql`
    select settings->'overheadApplication' as c from orgs where id = ${orgId}`));
  return r.rows[0]?.c ?? null;
}

async function applicationAudits(orgId: string): Promise<number> {
  const r = await withBypassContext(() => db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = 'orgs'
       and changes ? 'overheadApplication'`));
  return r.rows[0]!.n;
}

async function storedLifecycle(orgId: string): Promise<unknown> {
  const r = await withBypassContext(() => db.execute(sql`
    select settings->'overheadRateLifecycle' as c from orgs where id = ${orgId}`));
  return r.rows[0]?.c ?? null;
}

async function lifecycleAudits(orgId: string): Promise<number> {
  const r = await withBypassContext(() => db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = 'orgs'
       and changes ? 'overheadRateLifecycle'`));
  return r.rows[0]!.n;
}

function post(body: unknown): Promise<Response> {
  return POST(new Request("http://localhost/api/admin/setup/overhead", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

test("set-application refuses a nonexistent posting account", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    const response = await post({ action: "set-application", mode: "net_zero_pair", accountId: randomUUID() });
    assert.equal(response.status, 422);
    assert.equal(await storedApplication(org.orgId), null);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("set-application refuses an inactive account", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    await withBypassContext(() => db.execute(sql`
      update accounts set is_active = false where id = ${org.accounts.adjustment}`));
    const response = await post({ action: "set-application", mode: "net_zero_pair", accountId: org.accounts.adjustment });
    assert.equal(response.status, 422);
    assert.equal(await storedApplication(org.orgId), null);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("set-application stores a real account with audit evidence", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    const response = await post({ action: "set-application", mode: "net_zero_pair", accountId: org.accounts.adjustment });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.deepEqual(await storedApplication(org.orgId), { mode: "net_zero_pair", accountId: org.accounts.adjustment });
    assert.equal(await applicationAudits(org.orgId), 1);
    const evidence = await withBypassContext(() => db.execute(sql`
      select changes, actor_id as "actorId" from audit_log
       where org_id = ${org.orgId} and table_name = 'orgs' and changes ? 'overheadApplication'
       order by id desc limit 1`));
    assert.deepEqual(evidence.rows[0]?.changes, {
      overheadApplication: {
        before: null,
        after: { mode: "net_zero_pair", accountId: org.accounts.adjustment },
      },
    });
    assert.equal(evidence.rows[0]?.actorId, actorId);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("set-lifecycle refuses a supplied mode outside the enum without writing", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    const response = await post({ action: "set-lifecycle", mode: "hourly", cadence: "monthly" });
    assert.equal(response.status, 422);
    assert.equal(await storedLifecycle(org.orgId), null);
    assert.equal(await lifecycleAudits(org.orgId), 0);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("set-lifecycle refuses a supplied cadence outside the enum without writing", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    const response = await post({ action: "set-lifecycle", mode: "scheduled", cadence: "weekly" });
    assert.equal(response.status, 422);
    assert.equal(await storedLifecycle(org.orgId), null);
    assert.equal(await lifecycleAudits(org.orgId), 0);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("set-application refuses a supplied mode outside the enum without writing", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    const response = await post({ action: "set-application", mode: "amortize" });
    assert.equal(response.status, 422);
    assert.equal(await storedApplication(org.orgId), null);
    assert.equal(await applicationAudits(org.orgId), 0);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("omitted mode/cadence keep the documented defaults", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    const lifecycle = await post({ action: "set-lifecycle" });
    assert.equal(lifecycle.status, 200, JSON.stringify(await lifecycle.clone().json()));
    assert.deepEqual(await storedLifecycle(org.orgId), { mode: "manual", cadence: "monthly" });
    const application = await post({ action: "set-application" });
    assert.equal(application.status, 200, JSON.stringify(await application.clone().json()));
    assert.deepEqual(await storedApplication(org.orgId), { mode: "report_only", accountId: null });
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("set-lifecycle audit failure rolls the policy back", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `overhead_audit_failure_${suffix}`;
  const triggerName = `overhead_audit_failure_trigger_${suffix}`;
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
    routeState.gate = { user: { orgId: org.orgId, id: actorId } };
    await withBypassContext(() => db.execute(sql.raw(`
      create function public."${functionName}"() returns trigger
      language plpgsql as $$
      begin
        if new.table_name = 'orgs' then
          raise exception 'forced overhead audit failure';
        end if;
        return new;
      end $$;
      create trigger "${triggerName}"
        before insert on audit_log
        for each row execute function public."${functionName}"();
    `)));
    await assert.rejects(
      () => post({ action: "set-lifecycle", mode: "scheduled", cadence: "quarterly" }),
      (error: unknown) => {
        let current: unknown = error;
        while (current && typeof current === "object") {
          const message = (current as { message?: unknown }).message;
          if (typeof message === "string" && message.includes("forced overhead audit failure")) return true;
          current = (current as { cause?: unknown }).cause;
        }
        return false;
      },
    );
    const r = await withBypassContext(() => db.execute(sql`
      select settings->'overheadRateLifecycle' as c from orgs where id = ${org.orgId}`));
    assert.equal(r.rows[0]?.c ?? null, null);
  } finally {
    await withBypassContext(() => db.execute(sql.raw(`
      drop trigger if exists "${triggerName}" on audit_log;
      drop function if exists public."${functionName}"();
    `)));
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});
