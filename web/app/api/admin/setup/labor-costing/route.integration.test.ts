import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for the labor-costing settings boundary. The PUT
// handler used to write org.settings.laborCosting BEFORE validating the
// control accounts, silently dropped malformed burden components, and wrote
// settings / accounts / audit as separate autocommit statements — so a 422
// could still persist policy and a mid-save failure committed without audit
// evidence. These tests prove strict all-or-nothing rejection against real
// PostgreSQL.
const stateKey = Symbol.for("openbooks.labor-costing-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.labor-costing-route-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as platform.test.ts).
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // Forward Next.js-style aliases to the real modules they point at.
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (specifier === "../../../../../lib/authz" && context.parentURL?.includes("setup/labor-costing")) {
      return { url: "mock:authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?labor-costing-boundary-test";
const { PUT } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);

interface Fixture {
  orgId: string;
  actorId: string;
  /** non-summary accounts usable as control-account targets */
  wipAccount: string;
  clearingAccount: string;
  varianceAccount: string;
}

async function seed(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Labor Admin", "admin");
  // The route sits behind the Projects feature gate.
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ projects: true })}::jsonb)
     where id = ${org.orgId}`);
  return {
    orgId: org.orgId,
    actorId,
    wipAccount: org.accounts.invAsset,
    clearingAccount: org.accounts.clearing,
    varianceAccount: org.accounts.cogs,
  };
}

function putRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/setup/labor-costing", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

interface StoredPolicy {
  mode: string;
  hoursPerDay: string;
  annualHours: string;
  components: Record<string, unknown>[];
}

async function storedPolicy(orgId: string): Promise<StoredPolicy | null> {
  const rows = await db.execute<{ c: StoredPolicy | null }>(sql`
    select settings->'laborCosting' as c from orgs where id = ${orgId}`);
  return rows.rows[0]!.c ?? null;
}

async function storedControl(orgId: string, key: string): Promise<string | null> {
  const rows = await db.execute<{ v: string | null }>(sql`
    select settings#>>'{controlAccounts,${sql.raw(key)}}' as v from orgs where id = ${orgId}`);
  return rows.rows[0]!.v ?? null;
}

/** A rejected save must leave zero trace: no policy, no accounts, no audit. */
async function assertNothingPersisted(orgId: string): Promise<void> {
  assert.equal(await storedPolicy(orgId), null);
  for (const key of ["laborWip", "laborClearing", "payrollVariance"]) {
    assert.equal(await storedControl(orgId, key), null);
  }
  const audits = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = 'orgs'`);
  assert.equal(audits.rows[0]!.n, 0);
}

test("a valid save persists policy, control accounts, and audit evidence in one unit", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    const res = await PUT(putRequest({
      settings: {
        mode: "post",
        hoursPerDay: 8.5,
        annualHours: 2000,
        components: [
          { key: "burden", name: "Statutory Burden", kind: "percent_of_wage", value: 13, scaleWithOvertime: true },
          { kind: "per_day", value: "75.50" },
        ],
      },
      laborWip: f.wipAccount,
      laborClearing: f.clearingAccount,
      payrollVariance: f.varianceAccount,
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const after: StoredPolicy = {
      mode: "post",
      hoursPerDay: "8.5000",
      annualHours: "2000.0000",
      components: [
        { key: "burden", name: "Statutory Burden", kind: "percent_of_wage", value: "13", scaleWithOvertime: true },
        { key: "c1", name: "Component", kind: "per_day", value: "75.5", scaleWithOvertime: false },
      ],
    };
    assert.deepEqual(await storedPolicy(f.orgId), after);
    assert.equal(await storedControl(f.orgId, "laborWip"), f.wipAccount);
    assert.equal(await storedControl(f.orgId, "laborClearing"), f.clearingAccount);
    assert.equal(await storedControl(f.orgId, "payrollVariance"), f.varianceAccount);

    // Audit evidence is part of the same commit: exactly one row carrying
    // before → after for the policy and each control account.
    const audits = await db.execute<{ action: string; actor_id: string | null; changes: Record<string, unknown> }>(sql`
      select action, actor_id, changes from audit_log
       where org_id = ${f.orgId} and table_name = 'orgs'
       order by at`);
    assert.equal(audits.rows.length, 1);
    const audit = audits.rows[0]!;
    assert.equal(audit.action, "update");
    assert.equal(audit.actor_id, f.actorId);
    assert.deepEqual(audit.changes.laborCosting, [null, after]);
    assert.deepEqual(audit.changes.controlAccounts, {
      laborWip: [null, f.wipAccount],
      laborClearing: [null, f.clearingAccount],
      payrollVariance: [null, f.varianceAccount],
    });
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/test-fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("a malformed component rejects the whole save and persists nothing", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    // Each payload used to be silently sanitized (bad entries dropped, rest
    // saved) — now every one is a strict 422 with nothing written.
    const malformedComponents: unknown[] = [
      [{ kind: "annual_bonus", value: 5 }],
      [{ kind: "per_hour", value: -2 }],
      [{ kind: "per_hour", value: "1.23456" }],
      [{ kind: "per_hour" }],
      [{ kind: "per_day", value: 10, scaleWithOvertime: "yes" }],
      ["not-an-object"],
    ];
    for (const components of malformedComponents) {
      const res = await PUT(putRequest({
        settings: { mode: "post", hoursPerDay: 8, annualHours: 2080, components },
        laborWip: f.wipAccount,
      }));
      assert.equal(res.status, 422, `expected 422 for components ${JSON.stringify(components)}`);
    }

    // Structural refusals around the component list itself.
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ kind: "per_hour", value: i }));
    for (const settings of [
      { mode: "post", hoursPerDay: 8, annualHours: 2080, components: tooMany },
      { mode: "post", hoursPerDay: 8, annualHours: 2080, components: "burden" },
      { mode: "sometimes", hoursPerDay: 8, annualHours: 2080, components: [] },
    ]) {
      const res = await PUT(putRequest({ settings }));
      assert.equal(res.status, 422, `expected 422 for settings ${JSON.stringify(settings)}`);
    }

    await assertNothingPersisted(f.orgId);
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/test-fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("a valid save with an invalid control account persists NOTHING — not even the settings", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    // Regression: the old handler had already written laborCosting before it
    // validated the account ids, so this 422 still persisted the policy.
    const badUuid = await PUT(putRequest({
      settings: { mode: "post", hoursPerDay: 7.5, annualHours: 1900, components: [] },
      laborWip: "not-a-uuid",
    }));
    assert.equal(badUuid.status, 422);
    await assertNothingPersisted(f.orgId);

    // An unknown or summary account must equally refuse the whole save.
    const summaryId = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${summaryId}, ${f.orgId}, '9999', 'Summary Rollup', 'asset_current_other', true, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
    for (const [key, accountId] of [
      ["laborClearing", randomUUID()],
      ["laborWip", summaryId],
    ] as const) {
      const res = await PUT(putRequest({
        settings: { mode: "post", hoursPerDay: 7.5, annualHours: 1900, components: [] },
        [key]: accountId,
      }));
      assert.equal(res.status, 422);
      assert.deepEqual(await res.json(), { error: `${key}: account not found or is a summary account` });
    }
    await assertNothingPersisted(f.orgId);
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/test-fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("re-saves keep the audit trail continuous — before values match what was stored", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    const first = {
      mode: "post",
      hoursPerDay: "8.0000",
      annualHours: "2080.0000",
      components: [{ key: "burden", name: "Burden", kind: "percent_of_wage", value: "30", scaleWithOvertime: true }],
    };
    const res1 = await PUT(putRequest({
      settings: { ...first, hoursPerDay: 8, components: first.components.map((c) => ({ ...c, value: 30 })) },
      laborWip: f.wipAccount,
      laborClearing: f.clearingAccount,
    }));
    assert.equal(res1.status, 200);

    // Second save revises the policy and clears one control account; the new
    // audit row must record the previous values as its `before` side.
    const second: StoredPolicy = {
      mode: "off",
      hoursPerDay: "7.5000",
      annualHours: "1900.0000",
      components: [],
    };
    const res2 = await PUT(putRequest({
      settings: second,
      laborWip: null,
      payrollVariance: f.varianceAccount,
    }));
    assert.equal(res2.status, 200);
    assert.deepEqual(await storedPolicy(f.orgId), second);
    // Clearing sends an explicit jsonb null, read back as SQL NULL.
    assert.equal(await storedControl(f.orgId, "laborWip"), null);
    // laborClearing was absent from the second payload — it keeps its value,
    // and the audit row must not fabricate evidence for untouched keys.
    assert.equal(await storedControl(f.orgId, "laborClearing"), f.clearingAccount);
    assert.equal(await storedControl(f.orgId, "payrollVariance"), f.varianceAccount);

    const audits = await db.execute<{ changes: { laborCosting: unknown[]; controlAccounts: Record<string, unknown[]> } }>(sql`
      select changes from audit_log
       where org_id = ${f.orgId} and table_name = 'orgs'
       order by at`);
    assert.equal(audits.rows.length, 2);
    const evidence = audits.rows[1]!.changes;
    assert.deepEqual(evidence.laborCosting[0], first);
    assert.deepEqual(evidence.laborCosting[1], second);
    assert.deepEqual(evidence.controlAccounts.laborWip, [f.wipAccount, null]);
    assert.deepEqual(evidence.controlAccounts.payrollVariance, [null, f.varianceAccount]);
    // Untouched keys leave no fabricated evidence.
    assert.ok(!("laborClearing" in evidence.controlAccounts));
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/test-fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});
