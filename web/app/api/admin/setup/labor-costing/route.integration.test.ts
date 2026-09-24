import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
//
// The rate-mutation half proves the same atomicity discipline for
// effective-dated wages: close + upsert + audit commit in ONE transaction
// under a same-scope advisory lock. A fault injected after the close (or on
// the audit insert) must roll the whole timeline back — no committed gap, no
// orphan audit — and concurrent same-scope starts must serialize into one
// deterministic, fully evidenced timeline.
const stateKey = Symbol.for("openbooks.labor-costing-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
  /** Return true to fail the statement whose static SQL text is passed. */
  fault: ((text: string) => boolean) | null;
  /** Observe every statement's static SQL text (for interleaving control). */
  onExecute: ((text: string) => void) | null;
}
const routeState: RouteState = { authz: null, fault: null, onExecute: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const laborCostingWizardSource = readFileSync(
  "web/app/(app)/admin/setup/labor-costing/LaborCostingWizard.tsx",
  "utf8",
);

// Pure mirrors of web/lib/authz.ts's in-memory gates (the real module pulls in
// the session/cookie stack the plain runner cannot load). guardPermission is
// the seam; the scope helpers must behave exactly like production.
const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.labor-costing-route-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export function can(authz, permission) {
    const permissions = authz?.permissions ?? new Set()
    if (permissions.has('*')) return true
    if (permissions.has(permission)) return true
    const ns = permission.split('.')[0]
    return permissions.has(ns + '.*')
  }
  export function subsidiaryScopeAllows(scope, subsidiaryId, opts = {}) {
    if (scope === null) return true
    if (subsidiaryId === null || subsidiaryId === undefined || subsidiaryId === '') {
      return opts.orgWideNull === true
    }
    return scope.has(subsidiaryId)
  }
  export function guardSubsidiaryScope(authz, subsidiaryId, opts = {}) {
    if (subsidiaryScopeAllows(authz.allowedSubsidiaryIds, subsidiaryId, opts)) return null
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }
  export function subsidiariesInScope(authz, ids) {
    const scope = authz.allowedSubsidiaryIds
    if (scope === null) return true
    return ids.every((id) => id !== null && id !== undefined && id !== '' && scope.has(id))
  }
`;
let authzRealUrl = '';

// The rate paths delegate to the real db module (real pool, real RLS, real
// transaction) through this wrapper, which adds fault injection and statement
// observation. Failures are thrown BEFORE delegating, so the surrounding
// withOrgTransaction sees a genuine mid-transaction database error.
const mockDbWrapper = (realUrl: string) => `
  export * from ${JSON.stringify(realUrl)}
  const state = globalThis[Symbol.for('openbooks.labor-costing-route-test')]
  const real = await import(${JSON.stringify(realUrl)})
  function sqlText(query) {
    try {
      if (query && Array.isArray(query.queryChunks)) {
        return query.queryChunks
          .map((chunk) => (chunk && Array.isArray(chunk.value) ? chunk.value.join('') : ''))
          .join(' ')
      }
    } catch {}
    return String(query ?? '')
  }
  async function execute(...args) {
    const text = sqlText(args[0])
    if (state.onExecute) state.onExecute(text)
    if (state.fault && state.fault(text)) {
      throw new Error('injected database failure after: ' + text.replaceAll(/\\s+/g, ' ').slice(0, 90))
    }
    return real.db.execute(...args)
  }
  export const db = new Proxy(real.db, {
    get(target, prop, receiver) {
      if (prop === 'execute') return execute
      return Reflect.get(target, prop, receiver)
    },
  })
  export const withOrgTransaction = real.withOrgTransaction
  export const orgContext = real.orgContext
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
      authzRealUrl = nextResolve(specifier, context).url;
      return { url: "mock:authz", shortCircuit: true };
    }
    // The route's own db import is wrapped, and so is the canonical
    // wage writer's (HR-12 extracted save-rate into
    // engine/src/projects/labor-cost-rates.ts): the fault seam follows
    // the writer, so mid-transaction failures still surface inside the
    // same unit. Every other engine module keeps the real module.
    if (
      (specifier === "@openbooks/engine/src/platform/db.ts" ||
        // The writer imports the platform db relatively (engine
        // convention); both spellings resolve to the same module.
        specifier === "../platform/db.ts") &&
      (context.parentURL?.includes("setup/labor-costing/route.ts") ||
        context.parentURL?.includes("projects/labor-cost-rates.ts"))
    ) {
      return { url: "mock:dbwrap", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") {
      return { format: "module", source: `export { guardUnrestrictedScope } from ${JSON.stringify(authzRealUrl)};\n${mockAuthz}`, shortCircuit: true };
    }
    if (url === "mock:dbwrap") {
      // Delegate to the SAME real-module instance the fixtures use.
      const realUrl = import.meta.resolve("@openbooks/engine/src/platform/db.ts");
      return { format: "module", source: mockDbWrapper(realUrl), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?labor-costing-boundary-test";
const { GET, PUT, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

interface Fixture {
  orgId: string;
  actorId: string;
  /** the scratch org's own (in-scope for everyone) subsidiary */
  subsidiaryId: string;
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
    subsidiaryId: org.subsidiaryId,
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

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/setup/labor-costing", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Org-default wage save — one explicit scope per test via overrides. */
function saveRateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "save-rate",
    employeePartyId: null,
    jobTitle: null,
    tradeId: null,
    departmentId: null,
    subsidiaryId: null,
    currency: "CAD",
    rate: 100,
    basis: "hour",
    annualHours: 2080,
    effectiveFrom: "2026-01-01",
    ...overrides,
  };
}

test("a restricted setup actor cannot change org-wide labor costing policy", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: new Set([f.subsidiaryId]),
    };
    const res = await PUT(putRequest({ settings: { mode: "post", hoursPerDay: 8, annualHours: 2080, components: [] } }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "requires unrestricted subsidiary access" });
    assert.equal(await storedPolicy(f.orgId), null);
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

type StoredRate = {
  id: string;
  rate: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

async function storedRates(orgId: string): Promise<StoredRate[]> {
  const rows = await db.execute<StoredRate>(sql`
    select id, rate::text as rate, effective_from::text as "effectiveFrom",
           effective_to::text as "effectiveTo", is_active as "isActive"
      from labor_cost_rates
     where org_id = ${orgId}
     order by effective_from`);
  return rows.rows;
}

type RateAudit = {
  action: string;
  actor_id: string | null;
  changes: {
    reason?: string;
    scope?: Record<string, unknown>;
    effectiveFrom?: string;
    before?: unknown;
    after?: unknown;
  };
}

async function rateAudits(orgId: string): Promise<RateAudit[]> {
  const rows = await db.execute<RateAudit>(sql`
    select action, actor_id, changes
      from audit_log
     where org_id = ${orgId} and table_name = 'labor_cost_rates'
     order by at, id`);
  return rows.rows;
}

/** A second (child) subsidiary of the scratch org — a distinct wage scope. */
async function seedSubsidiary(orgId: string, parentId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${orgId}, ${parentId}, ${name}, 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

async function seedEmployee(orgId: string, subsidiaryId: string | null): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom, subsidiary_id)
    values (${partyId}, ${orgId}, 'employee', 'Waged Employee', true, '{}'::jsonb, ${subsidiaryId})`);
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, is_active)
    values (${orgId}, ${partyId}, true)`);
  return partyId;
}

interface StoredPolicy {
  mode: string;
  hoursPerDay: string;
  annualHours: string;
  components: Record<string, unknown>[];
  allowUnratedTime: boolean;
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

// Complete asynchronous setup before registering tests so --test-force-exit
// cannot finish the initial queue while later tests are still being loaded.
test("the labor-costing wizard saves fallback wages with configured currency and exact decimals", () => {
  assert.match(
    laborCostingWizardSource,
    /action:\s*'save-rate',[\s\S]{0,200}currency,[\s\S]{0,100}rate:\s*exactFallbackRate/,
  );
  assert.doesNotMatch(laborCostingWizardSource, /rate:\s*Number\(fallbackRate\)/);
});

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
      allowUnratedTime: false,
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
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("allowUnratedTime persists when explicitly set and rejects non-booleans", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    const res = await PUT(putRequest({
      settings: { mode: "off", hoursPerDay: 8, annualHours: 2080, components: [], allowUnratedTime: true },
    }));
    assert.equal(res.status, 200);
    assert.equal((await storedPolicy(f.orgId))?.allowUnratedTime, true);

    const bad = await PUT(putRequest({
      settings: { mode: "off", hoursPerDay: 8, annualHours: 2080, components: [], allowUnratedTime: "yes" },
    }));
    assert.equal(bad.status, 422);
    // The rejected save left the stored opt-in exactly as it was.
    assert.equal((await storedPolicy(f.orgId))?.allowUnratedTime, true);
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
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
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
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
      assert.deepEqual(await res.json(), { error: `${key}: account not found, inactive, or is a summary account` });
    }
    await assertNothingPersisted(f.orgId);
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
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
      allowUnratedTime: false,
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
      allowUnratedTime: false,
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
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("a save whose INSERT fails after the close commits NO rate gap and NO orphan audit", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    // Prior open rate, saved through the real path (one audit row).
    const first = await POST(postRequest(saveRateBody({ rate: 100, effectiveFrom: "2026-01-01" })));
    assert.equal(first.status, 200);

    // Arm the injected failure on the replacement upsert — it fires after the
    // close UPDATE has already run inside the same transaction.
    routeState.fault = (text) => text.replaceAll(/\s+/g, " ").trim().startsWith("insert into labor_cost_rates");
    const failed = await POST(postRequest(saveRateBody({ rate: 120, effectiveFrom: "2026-03-01" })));
    routeState.fault = null;
    assert.equal(failed.status, 422);

    // The close rolled back WITH the failed insert: the prior rate is still
    // fully open, there is no successor, and no audit row exists for the
    // failed save — the old two-autocommit-statement code committed the
    // premature effective_to here.
    const rates = await storedRates(f.orgId);
    assert.equal(rates.length, 1);
    assert.equal(rates[0]!.effectiveTo, null);
    assert.equal(rates[0]!.rate, "100.0000");
    const audits = await rateAudits(f.orgId);
    assert.equal(audits.length, 1);
  } finally {
    routeState.fault = null;
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("a save whose AUDIT write fails rolls the close and the replacement back together", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    const first = await POST(postRequest(saveRateBody({ rate: 100, effectiveFrom: "2026-01-01" })));
    assert.equal(first.status, 200);

    // Fail the LAST write in the unit: data must not survive without evidence.
    routeState.fault = (text) => text.replaceAll(/\s+/g, " ").includes("insert into audit_log");
    const failed = await POST(postRequest(saveRateBody({ rate: 120, effectiveFrom: "2026-03-01" })));
    routeState.fault = null;
    assert.equal(failed.status, 422);

    const rates = await storedRates(f.orgId);
    assert.equal(rates.length, 1);
    assert.equal(rates[0]!.effectiveTo, null);
    assert.equal(await rateAudits(f.orgId).then((rows) => rows.length), 1);
  } finally {
    routeState.fault = null;
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("concurrent same-scope starts serialize into one deterministic, fully evidenced timeline", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    // Deterministic interleave: B launches only once A is inside its
    // transaction holding the same-scope advisory lock (observed on A's close
    // statement — the lock statement before it has already completed).
    let releaseB: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let released = false;
    routeState.onExecute = (text) => {
      if (!released && text.replaceAll(/\s+/g, " ").trim().startsWith("update labor_cost_rates")) {
        released = true;
        releaseB();
      }
    };

    const promiseA = POST(postRequest(saveRateBody({ rate: 100, effectiveFrom: "2026-01-01" })));
    await barrier;
    const promiseB = POST(postRequest(saveRateBody({ rate: 120, effectiveFrom: "2026-03-01" })));
    const [resA, resB] = await Promise.all([promiseA, promiseB]);
    routeState.onExecute = null;
    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);

    // One timeline: A closed the day before B starts, B open — no gap, no
    // overlap, no lost update.
    const rates = await storedRates(f.orgId);
    assert.equal(rates.length, 2);
    const [a, b] = rates as [StoredRate, StoredRate];
    assert.equal(a.rate, "100.0000");
    assert.equal(a.effectiveTo, "2026-02-28");
    assert.equal(b.rate, "120.0000");
    assert.equal(b.effectiveFrom, "2026-03-01");
    assert.equal(b.effectiveTo, null);

    // Both writes carry attributable before/after evidence; B's audit records
    // the exact committed state it serialized after.
    const audits = await rateAudits(f.orgId);
    assert.equal(audits.length, 2);
    assert.equal(audits[0]!.action, "insert");
    assert.equal(audits[0]!.actor_id, f.actorId);
    assert.equal(audits[1]!.actor_id, f.actorId);
    const secondBefore = audits[1]!.changes.before as StoredRate[];
    assert.equal(secondBefore.length, 1);
    assert.equal(secondBefore[0]!.id, a.id);
    // B's evidence records the exact state it displaced: A still open before
    // B's close (the committed '2026-02-28' end date is B's own doing, proven
    // by the row state above).
    assert.equal(secondBefore[0]!.effectiveTo, null);
    assert.equal((audits[1]!.changes.after as StoredRate).id, b.id);
  } finally {
    routeState.onExecute = null;
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("saves keep exact decimal/date scope evidence — new start, correction in place, then end and delete", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    const first = await POST(postRequest(saveRateBody({ rate: "100.5", effectiveFrom: "2026-01-01" })));
    assert.equal(first.status, 200);
    const successor = await POST(postRequest(saveRateBody({ rate: 120, effectiveFrom: "2026-03-01" })));
    assert.equal(successor.status, 200);

    let rates = await storedRates(f.orgId);
    assert.equal(rates.length, 2);
    assert.equal(rates[0]!.effectiveTo, "2026-02-28");
    assert.equal(rates[1]!.effectiveTo, null);

    // Correcting the SAME start replaces the row in place and audits both
    // versions with exact decimal semantics.
    const correction = await POST(postRequest(saveRateBody({
      rate: "125.25",
      effectiveFrom: "2026-03-01",
      reason: "correction: wrong step",
    })));
    assert.equal(correction.status, 200);
    rates = await storedRates(f.orgId);
    assert.equal(rates.length, 2);
    assert.equal(rates[1]!.rate, "125.2500");

    let audits = await rateAudits(f.orgId);
    assert.equal(audits.length, 3);
    assert.equal(audits[0]!.action, "insert");
    assert.deepEqual(audits[0]!.changes.before, []);
    assert.equal((audits[0]!.changes.after as StoredRate).rate, "100.5000");
    assert.equal(audits[0]!.changes.reason, "wage rate saved");
    assert.equal(audits[1]!.action, "insert");
    assert.equal(audits[2]!.action, "update");
    assert.equal(audits[2]!.changes.reason, "correction: wrong step");
    assert.equal((audits[2]!.changes.before as StoredRate[])[0]!.rate, "120.0000");
    assert.equal((audits[2]!.changes.after as StoredRate).rate, "125.2500");
    assert.equal((audits[2]!.changes.after as StoredRate).id, rates[1]!.id);
    assert.equal(audits[2]!.changes.effectiveFrom, "2026-03-01");

    // Ending a rate carries the reason and the exact before/after dates.
    const ended = await POST(postRequest({
      action: "end-rate",
      id: rates[1]!.id,
      effectiveTo: "2026-06-30",
      reason: "contract ended",
    }));
    assert.equal(ended.status, 200);
    audits = await rateAudits(f.orgId);
    assert.equal(audits.length, 4);
    assert.equal(audits[3]!.action, "update");
    assert.equal(audits[3]!.changes.reason, "contract ended");
    assert.equal((audits[3]!.changes.before as StoredRate).effectiveTo, null);
    assert.equal((audits[3]!.changes.after as StoredRate).effectiveTo, "2026-06-30");

    // Deleting (deactivating) carries the reason and both activation states.
    const deleted = await POST(postRequest({
      action: "delete-rate",
      id: rates[1]!.id,
      reason: "entered in error",
    }));
    assert.equal(deleted.status, 200);
    audits = await rateAudits(f.orgId);
    assert.equal(audits.length, 5);
    assert.equal(audits[4]!.action, "delete");
    assert.equal(audits[4]!.changes.reason, "entered in error");
    assert.equal((audits[4]!.changes.before as StoredRate).isActive, true);
    assert.equal((audits[4]!.changes.after as StoredRate).isActive, false);
    const ratesAfterDelete = await storedRates(f.orgId);
    assert.equal(ratesAfterDelete[1]!.isActive, false);
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("end/delete audit-write failures roll the data change back with the evidence", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };
    const saved = await POST(postRequest(saveRateBody({ rate: 100, effectiveFrom: "2026-01-01" })));
    assert.equal(saved.status, 200);
    const rates = await storedRates(f.orgId);
    const rateId = rates[0]!.id;

    routeState.fault = (text) => text.replaceAll(/\s+/g, " ").includes("insert into audit_log");
    const ended = await POST(postRequest({ action: "end-rate", id: rateId, effectiveTo: "2026-06-30" }));
    assert.equal(ended.status, 422);
    const deleted = await POST(postRequest({ action: "delete-rate", id: rateId }));
    assert.equal(deleted.status, 422);
    routeState.fault = null;

    // Neither the end date nor the deactivation survived without its audit.
    const after = await storedRates(f.orgId);
    assert.equal(after.length, 1);
    assert.equal(after[0]!.effectiveTo, null);
    assert.equal(after[0]!.isActive, true);
    assert.equal(await rateAudits(f.orgId).then((rows) => rows.length), 1);
  } finally {
    routeState.fault = null;
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("an inactive control account is refused like a summary one", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    const dormantId = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${dormantId}, ${f.orgId}, '9998', 'Dormant Account', 'asset_current_other', false, false, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
    const res = await PUT(putRequest({
      settings: { mode: "post", hoursPerDay: 8, annualHours: 2080, components: [] },
      laborWip: dormantId,
    }));
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: "laborWip: account not found, inactive, or is a summary account" });
    await assertNothingPersisted(f.orgId);
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("out-of-scope compensation is 404 to a restricted setup actor; variance posting needs gl.post", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    const subsidiaryB = await seedSubsidiary(f.orgId, f.subsidiaryId, "B Co");
    const employeeB = await seedEmployee(f.orgId, subsidiaryB);
    // Configure the variance accounts FIRST, so a leaked gate would have
    // everything it needs to post — proving the refusals below are the gates.
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };
    const configured = await PUT(putRequest({
      laborWip: f.wipAccount,
      laborClearing: f.clearingAccount,
      payrollVariance: f.varianceAccount,
    }));
    assert.equal(configured.status, 200);

    // An A-only setup actor: B employees, B rates, B reconcile and B posting
    // are all indistinguishable from nonexistent records.
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage", "gl.post"]),
      allowedSubsidiaryIds: new Set([f.subsidiaryId]),
    };
    const readB = await GET(new Request(`http://localhost/api/admin/setup/labor-costing?employee=${employeeB}`));
    assert.equal(readB.status, 404);
    const saveEmployeeB = await POST(postRequest(saveRateBody({ employeePartyId: employeeB })));
    assert.equal(saveEmployeeB.status, 404);
    const saveSubB = await POST(postRequest(saveRateBody({ subsidiaryId: subsidiaryB })));
    assert.equal(saveSubB.status, 404);
    const reconcileB = await POST(postRequest({
      action: "reconcile", periodStart: "2026-01-01", periodEnd: "2026-01-31", subsidiaryId: subsidiaryB,
    }));
    assert.equal(reconcileB.status, 404);
    const postB = await POST(postRequest({
      action: "post-variance", periodStart: "2026-01-01", periodEnd: "2026-01-31", subsidiaryId: subsidiaryB,
    }));
    assert.equal(postB.status, 404);

    // In scope, but without posting authority: 403 before any journal work.
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: new Set([f.subsidiaryId]),
    };
    const postWithoutAuthority = await POST(postRequest({
      action: "post-variance", periodStart: "2026-01-01", periodEnd: "2026-01-31", subsidiaryId: f.subsidiaryId,
    }));
    assert.equal(postWithoutAuthority.status, 403);
    assert.deepEqual(await postWithoutAuthority.json(), { error: "missing permission: gl.post" });

    // No wage row for B and no journal anywhere: the denials mutated nothing.
    const bRates = await storedRates(f.orgId);
    assert.equal(bRates.length, 0);
    const journals = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries where org_id = ${f.orgId}`);
    assert.equal(journals.rows[0]!.n, 0);
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("save-rate rejects an impossible calendar date with a field error, not a driver error", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };
    const res = await POST(postRequest(saveRateBody({ effectiveFrom: "2026-02-30" })));
    assert.equal(res.status, 422);
    const body = await res.json() as { error: string };
    // Exact documented client error — Drizzle's driver-error wrapper also
    // names the "effectiveFrom" column alias, so a substring match cannot
    // distinguish the two.
    assert.equal(body.error, "effectiveFrom (YYYY-MM-DD) required");
    assert.deepEqual(await storedRates(f.orgId), []);
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("end-rate rejects an impossible calendar date with a field error, not a driver error", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };
    const saved = await POST(postRequest(saveRateBody()));
    assert.equal(saved.status, 200);
    const rateId = (await storedRates(f.orgId))[0]!.id;
    const res = await POST(postRequest({ action: "end-rate", id: rateId, effectiveTo: "2026-02-30" }));
    assert.equal(res.status, 422);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "invalid effectiveTo");
    assert.equal((await storedRates(f.orgId))[0]!.effectiveTo, null);
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("reconcile rejects an impossible calendar date with a 422, never a 500", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };
    const put = await PUT(putRequest({
      settings: { mode: "post", hoursPerDay: 8, annualHours: 2000, components: [] },
      laborWip: f.wipAccount,
      laborClearing: f.clearingAccount,
      payrollVariance: f.varianceAccount,
    }));
    assert.equal(put.status, 200);
    const res = await POST(postRequest({
      action: "reconcile", periodStart: "2026-02-30", periodEnd: "2026-03-31", subsidiaryId: f.subsidiaryId,
    }));
    assert.equal(res.status, 422);
    const body = await res.json() as { error: string };
    assert.match(body.error, /periodStart\/periodEnd/);
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("a backdated save-rate persists mid-timeline, capped the day before its successor (F-t05-001)", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // F-t05-001: adding a rate effective BEFORE the current start (2026-09-05
  // against a 2026-09-17 start) 422'd on the overlap exclusion and the UI
  // toasted a generic failure — a silent no-op. Backdating is legitimate by
  // design (the retro finder names backdated wages over paid periods as a
  // trigger), so the save must land: the new row covers its start until the
  // day before the next start, and later rows are untouched.
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    const current = await POST(postRequest(saveRateBody({ rate: 32.5, effectiveFrom: "2026-09-17" })));
    assert.equal(current.status, 200);
    const future = await POST(postRequest(saveRateBody({ rate: 34, effectiveFrom: "2026-09-19" })));
    assert.equal(future.status, 200);

    const backdated = await POST(postRequest(saveRateBody({ rate: 35, effectiveFrom: "2026-09-05" })));
    assert.equal(backdated.status, 200);

    const rates = await storedRates(f.orgId);
    assert.equal(rates.length, 3);
    // Backdated row slots into history, capped before the Sep-17 start.
    assert.equal(rates[0]!.rate, "35.0000");
    assert.equal(rates[0]!.effectiveFrom, "2026-09-05");
    assert.equal(rates[0]!.effectiveTo, "2026-09-16");
    // Later rows keep their exact windows.
    assert.equal(rates[1]!.rate, "32.5000");
    assert.equal(rates[1]!.effectiveTo, "2026-09-18");
    assert.equal(rates[2]!.rate, "34.0000");
    assert.equal(rates[2]!.effectiveTo, null);

    const audits = await rateAudits(f.orgId);
    assert.equal(audits.length, 3);
    assert.equal(audits[2]!.action, "insert");
    assert.equal((audits[2]!.changes.after as StoredRate).effectiveTo, "2026-09-16");
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("a same-start correction keeps the row's window instead of reopening past its successor", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // The same-start upsert used to reset effective_to to null, which overlaps
  // the successor and trips the overlap exclusion on any mid-timeline row.
  // A correction changes terms, never the window — window edits go through
  // end-rate.
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    assert.equal((await POST(postRequest(saveRateBody({ rate: 100, effectiveFrom: "2026-01-01" })))).status, 200);
    assert.equal((await POST(postRequest(saveRateBody({ rate: 120, effectiveFrom: "2026-03-01" })))).status, 200);
    const backdated = await POST(postRequest(saveRateBody({ rate: 110, effectiveFrom: "2026-02-01" })));
    assert.equal(backdated.status, 200);

    let rates = await storedRates(f.orgId);
    assert.equal(rates.length, 3);
    assert.equal(rates[1]!.effectiveTo, "2026-02-28");

    const correction = await POST(postRequest(saveRateBody({ rate: 115, effectiveFrom: "2026-02-01" })));
    assert.equal(correction.status, 200);
    rates = await storedRates(f.orgId);
    assert.equal(rates.length, 3);
    assert.equal(rates[1]!.rate, "115.0000");
    assert.equal(rates[1]!.effectiveTo, "2026-02-28");
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("a storage refusal past validation never leaks driver text to the client", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // F-t05-001's 422 carried the full INSERT statement with bound org/actor
  // ids. Refusals map to a stable code + safe message instead.
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };

    assert.equal((await POST(postRequest(saveRateBody({ rate: 100, effectiveFrom: "2026-01-01" })))).status, 200);

    routeState.fault = (text) => text.replaceAll(/\s+/g, " ").trim().startsWith("insert into labor_cost_rates");
    const failed = await POST(postRequest(saveRateBody({ rate: 120, effectiveFrom: "2026-03-01" })));
    routeState.fault = null;
    assert.equal(failed.status, 422);
    const body = await failed.json() as { error: string; errorCode: string };
    assert.ok(body.errorCode === "overlap" || body.errorCode === "save", `unexpected code ${body.errorCode}`);
    assert.doesNotMatch(body.error, /insert into|params:|org_id/i);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(f.orgId));
  } finally {
    routeState.fault = null;
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("save-rate names WHICH wage scope is unavailable, with the supplied id", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // One message covered four distinct failed lookups (employee, trade,
  // department, subsidiary) as 'wage scope is not available'. Each refusal
  // must name the scope kind and the id it was given.
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    };
    const cases = [
      { field: "employeePartyId", kind: "employee" },
      { field: "tradeId", kind: "trade" },
      { field: "departmentId", kind: "department" },
      { field: "subsidiaryId", kind: "subsidiary" },
    ] as const;
    for (const { field, kind } of cases) {
      const missing = randomUUID();
      const refused = await POST(postRequest(saveRateBody({ [field]: missing })));
      assert.equal(refused.status, 422, field);
      const body = await refused.json() as { error: string };
      assert.match(body.error, new RegExp(`${kind} wage scope "${missing}" is not available`), field);
    }
    // No wage row from any refused save.
    assert.equal((await storedRates(f.orgId)).length, 0);
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});

test("reconcile and post-variance name a subsidiary that is missing, inactive, or elimination", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // Both actions refused every subsidiary failure as 'subsidiary is not
  // available'. Each refusal must name the id and which predicate failed.
  const f = await seed();
  try {
    routeState.authz = {
      user: { orgId: f.orgId, id: f.actorId },
      permissions: new Set(["admin.setup.manage", "gl.post"]),
      allowedSubsidiaryIds: null,
    };
    const period = { periodStart: "2026-01-01", periodEnd: "2026-01-31" };
    const missing = randomUUID();
    for (const action of ["reconcile", "post-variance"] as const) {
      const refused = await POST(postRequest({ action, ...period, subsidiaryId: missing }));
      assert.equal(refused.status, 422, action);
      assert.match(
        (await refused.json() as { error: string }).error,
        new RegExp(`no subsidiary "${missing}" in this organization`),
        action,
      );
    }
    const dormant = await seedSubsidiary(f.orgId, f.subsidiaryId, "Dormant Co");
    await db.execute(sql`update subsidiaries set is_active = false where id = ${dormant}`);
    const inactive = await POST(postRequest({ action: "reconcile", ...period, subsidiaryId: dormant }));
    assert.equal(inactive.status, 422);
    assert.match(
      (await inactive.json() as { error: string }).error,
      new RegExp(`subsidiary "Dormant Co" is inactive`),
    );
    const wash = await seedSubsidiary(f.orgId, f.subsidiaryId, "Wash Co");
    await db.execute(sql`update subsidiaries set is_elimination = true where id = ${wash}`);
    const elimination = await POST(postRequest({ action: "reconcile", ...period, subsidiaryId: wash }));
    assert.equal(elimination.status, 422);
    assert.match(
      (await elimination.json() as { error: string }).error,
      new RegExp(`subsidiary "Wash Co" is an elimination entity`),
    );
  } finally {
    routeState.authz = null;
    const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
    await dropScratchOrgReporting(f.orgId);
  }
});
