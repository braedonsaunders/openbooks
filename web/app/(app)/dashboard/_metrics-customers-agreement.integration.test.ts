import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The home dashboard's customer widgets read through the Customer
// Intelligence engine's own loaders over the dashboards' opening period, so
// a tile and its dashboard can never disagree. This file pins the wiring:
// the widget fields equal the loader's KPIs and row set on the same org,
// a broken weight sum refuses by name on every widget instead of throwing,
// and a widget nobody asked for leaves its field null (its reader never
// runs).
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({ intl: "export async function getTranslations(){return (key)=>key};export async function getLocale(){return 'en-CA'}" });
registerHooks({
  resolve(specifier, context, nextResolve) {
    // No request scope here: serve an empty cookie jar like the sibling
    // customer integration suites.
    if (specifier === "next/headers") return { shortCircuit: true, url: "data:text/javascript,export function cookies() { return { get() { return undefined } } }" };
    // Worktree node_modules is a symlink to the main checkout's install, so
    // bare @openbooks self-imports would resolve to MAIN-checkout code (a
    // second db pool without the test bypass). Pin them to this checkout.
    if (specifier.startsWith("@openbooks/engine/src/")) {
      return nextResolve(
        new URL(`../../../../engine/${specifier.slice("@openbooks/engine/".length)}`, import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, env, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { withSimClock: pinClock } = await import("@openbooks/engine/src/platform/clock.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { customerData, rankAtRiskCustomers } = await import("@/lib/analytics/customer-data.ts");
const { loadCustomerWidgetMetrics } = await import("./_metrics-customers.ts");
const { loadDashboardMetrics } = await import("./_metrics.ts");
const { canSeeWidget } = await import("./_widget-access.ts");
type Authz = import("@/lib/authz.ts").Authz;
type ScratchOrg = import("@openbooks/engine/src/testing/fixtures.ts").ScratchOrg;

const P = { from: "2026-07-01", to: "2026-07-31", label: "July 2026" };
const TODAY = "2026-07-15";
const WIDGETS = ["kpi-customer-concentration", "kpi-customers-at-risk", "list-customers-at-risk"] as const;

function authzFor(orgId: string, userId: string, permissions: string[]): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "Customer Watcher", orgId,
      roles: [{ key: "staff", name: "staff" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  };
}

async function invoice(
  org: ScratchOrg, actor: string, partyId: string, revenue: string, date: string,
): Promise<void> {
  const id = randomUUID();
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
     currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${id}, ${org.subsidiaryId},
      ${partyId}, ${date}, 'CAD', '1', ${revenue}, 0, ${revenue}, ${actor})`);
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, 1, ${revenue}, ${revenue}, 0, ${revenue})`);
  await db.execute(sql`update documents set status = 'approved' where id = ${id}`);
  await postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
}

test("customer widgets agree with the Customer Intelligence engine", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Customer Controller", "admin"));
    const anchor = randomUUID();
    const dormant = randomUUID();
    await withBypass(async () => {
      const cal = (await db.execute<{ fiscal_calendar_id: string }>(sql`
        select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`)).rows[0]!.fiscal_calendar_id;
      const prior = randomUUID();
      await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${prior}, ${org.orgId}, 2025, 7, '2025-07', '2025-07-01', '2025-07-31', false, ${cal})`);
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${anchor}, ${org.orgId}, 'customer', 'Anchor Co', true, '{}'::jsonb),
               (${dormant}, ${org.orgId}, 'customer', 'Dormant Co', true, '{}'::jsonb)`);
      await invoice(org, actor as unknown as string, anchor, "1000", "2026-07-10");
      await invoice(org, actor as unknown as string, dormant, "100", "2025-07-15");
    });

    // Customer figures need AR visibility, like the top-customers list.
    const authz = authzFor(org.orgId, actor as unknown as string, ["dashboard.read", "ar.read"]);
    for (const id of WIDGETS) assert.equal(canSeeWidget(authz, id), true, id);
    const denied = authzFor(org.orgId, actor as unknown as string, ["dashboard.read", "reports.read"]);
    for (const id of WIDGETS) assert.equal(canSeeWidget(denied, id), false, `${id} needs ar.read`);

    const ctx = {
      authz, orgId: org.orgId, today: TODAY, subsidiaryIds: undefined,
      allowedSubsidiaryIds: null,
      period: async () => ({ presetId: "month", ...P }),
    };
    const needAll = (...fields: string[]) => fields.length > 0;
    const [widgets, loader] = await pinClock(TODAY, () => withOrgContext(org.orgId, () => Promise.all([
      loadCustomerWidgetMetrics(ctx as never, needAll as never),
      customerData(P, org.orgId, null),
    ])));

    assert.ok(!loader.weightsError, `clean config must load, got: ${loader.weightsError}`);
    const concentration = widgets.concentration;
    assert.ok(concentration?.available, "concentration is available on a customer org");
    if (concentration?.available) {
      assert.deepEqual(concentration.value, {
        hhi: loader.kpis.hhiScaled,
        level: loader.kpis.hhiLevel,
        customersFor80Pct: loader.kpis.customersFor80Pct,
        topSharePct: loader.kpis.topCustomerShare,
      });
    }
    const atRisk = widgets.atRisk;
    assert.ok(atRisk?.available, "at-risk is available on a customer org");
    if (atRisk?.available) {
      assert.equal(atRisk.value.count, loader.kpis.atRiskCount, "tile count is the dashboard count");
      assert.equal(atRisk.value.revenue, loader.kpis.atRiskRevenue, "tile revenue is the dashboard revenue");
    }
    const list = widgets.atRiskCustomers;
    assert.ok(list?.available, "the at-risk list is available on a customer org");
    if (list?.available) {
      const expected = rankAtRiskCustomers(loader.rows);
      assert.ok(expected.length > 0, "the dormant customer keeps this agreement non-trivial");
      assert.ok(list.value.length <= 5, "the tile shows five customers at most");
      assert.deepEqual(list.value.map((c) => c.id), expected.map((r) => r.id), "tile order is the engine ranking");
      for (const customer of list.value) {
        const row = loader.rows.find((r) => r.id === customer.id)!;
        assert.equal(customer.churnScore, row.churnScore, "tile score is the dashboard score");
        assert.equal(customer.revenue, row.revenue, "tile revenue is the dashboard revenue");
      }
    }

    // The full dashboard path serves the same fields as available.
    const metrics = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () => loadDashboardMetrics(authz, [...WIDGETS])),
    );
    assert.ok(metrics.concentration?.available, "dashboard serves concentration");
    assert.ok(metrics.atRisk?.available, "dashboard serves at-risk");
    assert.ok(metrics.atRiskCustomers?.available, "dashboard serves the at-risk list");

    // A widget nobody asked for leaves its field null: its reader never runs.
    const empty = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () => loadDashboardMetrics(authz, [])),
    );
    assert.equal(empty.concentration, null);
    assert.equal(empty.atRisk, null);
    assert.equal(empty.atRiskCustomers, null);

    // A broken weight sum refuses by name on every widget instead of throwing.
    await withBypass(() => db.execute(sql`update orgs set settings = coalesce(settings, '{}'::jsonb)
      || '{"analytics":{"customerIntelligence":{"healthWeightRecency":24}}}'::jsonb
      where id = ${org.orgId}`));
    const refused = await pinClock(TODAY, () =>
      withOrgContext(org.orgId, () => loadCustomerWidgetMetrics(ctx as never, needAll as never)),
    );
    for (const [name, field] of Object.entries(refused) as Array<[string, { available: boolean; reason?: string } | null | undefined]>) {
      assert.ok(field && !field.available, `${name} refuses instead of rendering empty figures`);
      assert.ok(typeof field?.reason === "string" && field.reason.length > 0, `${name} says why`);
    }
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
