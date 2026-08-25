import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-PostgreSQL regression for the surcharge-rule setup boundary. The
// saveRule/deleteRule handlers used to accept silent zero-fee policies
// (missing/zero components, zero caps), pass malformed or inverted effective
// dates through to Postgres constraints, store fee-account references without
// checking them, report success on updates/deletes that affected zero rows,
// and write fabricated audit entries ({after: payload} / hardcoded isActive)
// in separate autocommit statements. These tests prove strict validation,
// deterministic effective dating, and atomic actual before→after audit
// evidence against real PostgreSQL.
const stateKey = Symbol.for("openbooks.payment-providers-route-test");
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
  const state = globalThis[Symbol.for('openbooks.payment-providers-route-test')]
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
    if (specifier === "../../../../../lib/authz" && context.parentURL?.includes("setup/payment-providers")) {
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

const routeUrl = "./route.ts?payment-providers-boundary-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);

interface Fixture {
  orgId: string;
  actorId: string;
  /** active non-summary income account usable as the fee target */
  revenueAccount: string;
}

async function seed(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Payments Admin", "admin");
  // The route sits behind the onlinePayments feature gate.
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ onlinePayments: true })}::jsonb)
     where id = ${org.orgId}`);
  return { orgId: org.orgId, actorId, revenueAccount: org.accounts.revenue };
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/setup/payment-providers", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function authorize(f: Fixture): void {
  routeState.authz = {
    user: { orgId: f.orgId, id: f.actorId },
    permissions: new Set(["admin.setup.manage"]),
    allowedSubsidiaryIds: null,
  };
}

/** How much trace exists in this org: stored rules and audit rows. */
async function trace(orgId: string): Promise<{ rules: number; audits: number }> {
  const rows = await db.execute<{ rules: number; audits: number }>(sql`
    select (select count(*)::int from payment_surcharge_rules where org_id = ${orgId}) as rules,
           (select count(*)::int from audit_log where org_id = ${orgId} and table_name = 'payment_surcharge_rules') as audits`);
  return rows.rows[0]!;
}

async function storedRules(orgId: string): Promise<Record<string, unknown>[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    select id, name, calculation, percent::text as percent, fixed_amount::text as "fixedAmount",
           cap_amount::text as "capAmount", fee_income_account_id as "feeIncomeAccountId",
           provider, payment_method as "paymentMethod", effective_from::text as "effectiveFrom",
           effective_to::text as "effectiveTo", is_active as "isActive"
      from payment_surcharge_rules where org_id = ${orgId} order by name`);
  return rows.rows;
}

type AuditRow = {
  action: string;
  actor_id: string | null;
  changes: { rule: [Record<string, unknown> | null, Record<string, unknown>] };
};

async function audits(orgId: string): Promise<AuditRow[]> {
  const rows = await db.execute<AuditRow>(sql`
    select action, actor_id, changes from audit_log
     where org_id = ${orgId} and table_name = 'payment_surcharge_rules'
     order by at, id`);
  return rows.rows;
}

function baseRule(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    action: "saveRule",
    name: "Card fee",
    calculation: "percent",
    percent: "2.5",
    fixedAmount: null,
    capAmount: null,
    feeIncomeAccountId: "will-be-set",
    provider: "stripe",
    paymentMethod: "card",
    effectiveFrom: "2026-01-01",
    ...overrides,
  };
}

/** Audit snapshots carry the audited columns, not the surrogate id. */
function withoutId(row: Record<string, unknown>): Record<string, unknown> {
  const { id, ...rest } = row;
  void id;
  return rest;
}

test("a valid surcharge rule persists with actual stored-row insert evidence", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    authorize(f);
    const res = await POST(postRequest(baseRule({ feeIncomeAccountId: f.revenueAccount, capAmount: "10" })));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const rules = await storedRules(f.orgId);
    assert.equal(rules.length, 1);
    const stored = rules[0]!;
    assert.deepEqual(stored, {
      id: stored.id,
      name: "Card fee",
      calculation: "percent",
      percent: "2.5000",
      fixedAmount: null,
      capAmount: "10.0000",
      feeIncomeAccountId: f.revenueAccount,
      provider: "stripe",
      paymentMethod: "card",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      isActive: true,
    });

    // Exactly one audit row whose after side IS the stored row — captured
    // from RETURNING, not restated from the request payload.
    const trail = await audits(f.orgId);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]!.action, "insert");
    assert.equal(trail[0]!.actor_id, f.actorId);
    const evidence = trail[0]!.changes.rule;
    assert.equal(evidence[0], null);
    assert.deepEqual(evidence[1], stored);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(f.orgId);
  }
});

test("silent zero-fee and misleading policies reject whole and persist nothing", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    authorize(f);
    // Each of these either computes an identically-zero fee (the component
    // the calculation uses is missing or zero, or a zero cap clamps every
    // fee to zero) or stores components its calculation silently ignores.
    const rejects: Record<string, unknown>[] = [
      baseRule({ calculation: "percent", percent: null, feeIncomeAccountId: f.revenueAccount }),
      baseRule({ calculation: "percent", percent: "0", feeIncomeAccountId: f.revenueAccount }),
      baseRule({ calculation: "percent", percent: "-2", feeIncomeAccountId: f.revenueAccount }),
      baseRule({ calculation: "fixed", percent: null, fixedAmount: null, feeIncomeAccountId: f.revenueAccount }),
      baseRule({ calculation: "fixed", percent: null, fixedAmount: "0", feeIncomeAccountId: f.revenueAccount }),
      baseRule({ calculation: "percent_plus_fixed", percent: null, fixedAmount: null, feeIncomeAccountId: f.revenueAccount }),
      baseRule({ calculation: "percent_plus_fixed", percent: "0", fixedAmount: "0.0000", feeIncomeAccountId: f.revenueAccount }),
      baseRule({ calculation: "percent", percent: "2.5", fixedAmount: "3", feeIncomeAccountId: f.revenueAccount }),
      baseRule({ calculation: "fixed", percent: "2", fixedAmount: "3", feeIncomeAccountId: f.revenueAccount }),
      baseRule({ percent: "2.5", capAmount: "0", feeIncomeAccountId: f.revenueAccount }),
    ];
    for (const body of rejects) {
      const res = await POST(postRequest(body));
      assert.equal(res.status, 422, `expected 422 for ${JSON.stringify(body)}`);
    }

    const after = await trace(f.orgId);
    assert.equal(after.rules, 0);
    assert.equal(after.audits, 0);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(f.orgId);
  }
});

test("effective dating accepts only real calendar days in start-to-end order", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    authorize(f);
    const badFrom = ["2026-02-30", "2026-13-01", "2026-00-10", "01/02/2026", "2026-1-1", "not-a-date"];
    for (const effectiveFrom of badFrom) {
      const res = await POST(postRequest(baseRule({ effectiveFrom, feeIncomeAccountId: f.revenueAccount })));
      assert.equal(res.status, 422, `expected 422 for effectiveFrom ${effectiveFrom}`);
    }
    const badTo: [string, string][] = [
      ["2026-02-30", "2026-02-30"], // not a calendar day
      ["2026-01-01", "2025-12-31"], // ends before it starts
    ];
    for (const [effectiveFrom, effectiveTo] of badTo) {
      const res = await POST(postRequest(baseRule({ effectiveFrom, effectiveTo, feeIncomeAccountId: f.revenueAccount })));
      assert.equal(res.status, 422, `expected 422 for range ${effectiveFrom}→${effectiveTo}`);
    }
    let t = await trace(f.orgId);
    assert.equal(t.rules, 0);
    assert.equal(t.audits, 0);

    // Same-day inclusive range is legal.
    const ok = await POST(postRequest(baseRule({
      effectiveFrom: "2026-03-01",
      effectiveTo: "2026-03-01",
      feeIncomeAccountId: f.revenueAccount,
    })));
    assert.equal(ok.status, 200);
    t = await trace(f.orgId);
    assert.equal(t.rules, 1);
    assert.equal(t.audits, 1);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(f.orgId);
  }
});

test("fee-income references must be real active non-summary income accounts", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    authorize(f);
    const summaryIncome = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${summaryIncome}, ${f.orgId}, '4999', 'Income Rollup', 'income', true, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
    const inactiveIncome = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${inactiveIncome}, ${f.orgId}, '4988', 'Closed Income', 'income', false, false, false, false, '[]'::jsonb, '{}'::jsonb, true)`);

    const rejects: string[] = [
      randomUUID(),
      summaryIncome,
      inactiveIncome,
    ];
    // The fixture's bank account is real but is not an income account.
    const banks = await db.execute<{ id: string }>(sql`
      select id from accounts where org_id = ${f.orgId} and type = 'asset_bank' limit 1`);
    rejects.push(banks.rows[0]!.id);

    for (const feeIncomeAccountId of rejects) {
      const res = await POST(postRequest(baseRule({ feeIncomeAccountId })));
      assert.equal(res.status, 422, `expected 422 for fee account ${feeIncomeAccountId}`);
    }

    const after = await trace(f.orgId);
    assert.equal(after.rules, 0);
    assert.equal(after.audits, 0);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(f.orgId);
  }
});

test("same-start same-scope saves conflict; distinct scopes coexist deterministically", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    authorize(f);
    const first = await POST(postRequest(baseRule({
      name: "Stripe card", provider: "stripe", effectiveFrom: "2026-01-01", feeIncomeAccountId: f.revenueAccount,
    })));
    assert.equal(first.status, 200);

    // A second active rule with identical scope and start date would make
    // resolveSurcharge's tie-break arbitrary — refused outright.
    const clash = await POST(postRequest(baseRule({
      name: "Stripe card again", provider: "stripe", effectiveFrom: "2026-01-01", feeIncomeAccountId: f.revenueAccount,
    })));
    assert.equal(clash.status, 409);
    let t = await trace(f.orgId);
    assert.equal(t.rules, 1);
    assert.equal(t.audits, 1);

    // Different provider scope on the same day resolves deterministically
    // (provider-specific beats all-provider), so both may coexist.
    for (const [name, provider] of [["Adyen card", "adyen"], ["All providers", null]] as const) {
      const res = await POST(postRequest(baseRule({ name, provider, effectiveFrom: "2026-01-01", feeIncomeAccountId: f.revenueAccount })));
      assert.equal(res.status, 200, `expected ${name} to save`);
    }

    // A different start date under the same scope is ordinary effective dating.
    const later = await POST(postRequest(baseRule({
      name: "Stripe card Feb", provider: "stripe", effectiveFrom: "2026-02-01", feeIncomeAccountId: f.revenueAccount,
    })));
    assert.equal(later.status, 200);

    // Card-only and bank-debit-only rules never serve the same checkout, so
    // they may share a start date; any overlapping method coverage ("all")
    // still conflicts with both.
    const debit = await POST(postRequest(baseRule({
      name: "Stripe debit", provider: "stripe", paymentMethod: "bank_debit",
      effectiveFrom: "2026-01-01", feeIncomeAccountId: f.revenueAccount,
    })));
    assert.equal(debit.status, 200);
    for (const [name, method] of [["Stripe all methods", "all"], ["Stripe card shadow", "card"]] as const) {
      const clash2 = await POST(postRequest(baseRule({
        name, provider: "stripe", paymentMethod: method,
        effectiveFrom: "2026-01-01", feeIncomeAccountId: f.revenueAccount,
      })));
      assert.equal(clash2.status, 409, `expected ${name} to conflict`);
    }

    t = await trace(f.orgId);
    assert.equal(t.rules, 5);
    assert.equal(t.audits, 5);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(f.orgId);
  }
});

test("updates record the actual previous row and refuse phantom or conflicting targets", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    authorize(f);
    const created = await POST(postRequest(baseRule({
      name: "Original", percent: "2.5", effectiveFrom: "2026-01-01", feeIncomeAccountId: f.revenueAccount,
    })));
    assert.equal(created.status, 200);
    const beforeRules = await storedRules(f.orgId);
    const ruleId = beforeRules[0]!.id as string;

    // Re-saving the same id keeps its date (self-excluded) and revises fields;
    // the audit row must carry the REAL prior row as its before side.
    const revised = await POST(postRequest(baseRule({
      id: ruleId, name: "Revised", percent: "3", effectiveFrom: "2026-01-01", feeIncomeAccountId: f.revenueAccount,
    })));
    assert.equal(revised.status, 200);

    const trail = await audits(f.orgId);
    assert.equal(trail.length, 2);
    assert.equal(trail[1]!.action, "update");
    const [before, after] = trail[1]!.changes.rule;
    assert.deepEqual(before, withoutId(beforeRules[0]!));
    const afterRules = await storedRules(f.orgId);
    assert.equal(afterRules.length, 1);
    assert.deepEqual(after, withoutId(afterRules[0]!));
    assert.notEqual((before as Record<string, unknown>).percent, (after as Record<string, unknown>).percent);

    // Updating onto another active rule's scope+start conflicts and leaves the
    // target row exactly as it was.
    await POST(postRequest(baseRule({
      name: "GoCardless", provider: "gocardless", effectiveFrom: "2026-03-01", feeIncomeAccountId: f.revenueAccount,
    })));
    const gcBefore = (await storedRules(f.orgId)).find((r) => r.name === "GoCardless");
    const conflicted = await POST(postRequest(baseRule({
      id: gcBefore!.id as string, name: "GoCardless moved", provider: "stripe",
      effectiveFrom: "2026-01-01", feeIncomeAccountId: f.revenueAccount,
    })));
    assert.equal(conflicted.status, 409);
    assert.deepEqual((await storedRules(f.orgId)).find((r) => r.name === "GoCardless"), gcBefore);

    // Phantom ids are affected-row misses: 404, and never fabricated audit
    // evidence claiming an update happened.
    const phantom = await POST(postRequest(baseRule({
      id: randomUUID(), name: "Ghost", effectiveFrom: "2026-04-01", feeIncomeAccountId: f.revenueAccount,
    })));
    assert.equal(phantom.status, 404);

    // Another org's rule id is equally invisible here.
    const other = await createScratchOrg();
    const foreignId = randomUUID();
    await db.execute(sql`
      insert into payment_surcharge_rules
        (id, org_id, name, calculation, percent, fee_income_account_id, payment_method, effective_from, created_by, updated_by)
      values (${foreignId}, ${other.orgId}, 'Foreign', 'fixed', '1', ${other.accounts.revenue}, 'all', '2026-01-01', null, null)`);
    const crossOrg = await POST(postRequest(baseRule({
      id: foreignId, name: "Hijack", effectiveFrom: "2026-01-01", feeIncomeAccountId: f.revenueAccount,
    })));
    assert.equal(crossOrg.status, 404);
    await dropScratchOrgReporting(other.orgId);

    const t = await trace(f.orgId);
    assert.equal(t.rules, 2);
    // Original insert + revision + GoCardless insert; conflicts and phantom
    // targets add nothing.
    assert.equal(t.audits, 3);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(f.orgId);
  }
});

test("deletion stores the real deactivated row and refuses phantom or repeat deletes", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await seed();
  try {
    authorize(f);
    await POST(postRequest(baseRule({ name: "Doomed", percent: "1.5", effectiveFrom: "2026-01-01", feeIncomeAccountId: f.revenueAccount })));
    const ruleId = (await storedRules(f.orgId))[0]!.id as string;

    const del = await POST(postRequest({ action: "deleteRule", id: ruleId }));
    assert.equal(del.status, 200);
    const rules = await storedRules(f.orgId);
    assert.equal(rules[0]!.isActive, false);

    // Evidence carries the actual deactivated configuration, not a hardcoded
    // {isActive} stub.
    const trail = await audits(f.orgId);
    assert.equal(trail.length, 2);
    assert.equal(trail[1]!.action, "delete");
    const [before, after] = trail[1]!.changes.rule;
    assert.equal(before!.isActive, true);
    assert.equal(before!.name, "Doomed");
    assert.equal(before!.percent, "1.5000");
    // The after side is exactly what is stored now: the same row, deactivated.
    assert.deepEqual(after, { ...withoutId(rules[0]!), isActive: false });

    // Re-deleting and phantom deletes change nothing and fabricate nothing.
    for (const id of [ruleId, randomUUID()]) {
      const res = await POST(postRequest({ action: "deleteRule", id }));
      assert.equal(res.status, 404, `expected 404 deleting ${id}`);
    }
    const t = await trace(f.orgId);
    assert.equal(t.rules, 1);
    assert.equal(t.audits, 2);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(f.orgId);
  }
});
