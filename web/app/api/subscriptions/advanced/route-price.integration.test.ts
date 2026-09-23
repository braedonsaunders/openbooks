import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * A catalog component's unit price is required and canonical: the route once
 * defaulted a missing price to "0", so an incomplete priced plan could be
 * published and invoiced at zero with the operator never choosing a free
 * component. Quantity keeps its documented default of one.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const engineRoot = new URL("../../../../../engine/", import.meta.url).href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __subscriptionPriceState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__subscriptionPriceState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['ar.create']), allowedSubsidiaryIds: null };
        }
      `);
    if (specifier.endsWith("/lib/features"))
      return virtual("export async function isFeatureEnabled() { return true }");
    if (specifier.startsWith("@openbooks/engine/")) {
      return next(new URL(specifier.slice("@openbooks/engine/".length), engineRoot).href, context);
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { createPlanVersion } = await import("@openbooks/engine/src/billing/advanced-subscriptions.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = settings || '{"features":{"subscriptionBilling":true,"advancedSubscriptions":true}}'::jsonb
     where id = ${org.orgId}`));
  const planId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into subscription_plans (id, org_id, name, amount, currency_code, interval, interval_count,
                                    income_account_id, is_active, created_by)
    values (${planId}, ${org.orgId}, 'Price Plan', '0', 'CAD', 'monthly', 1, ${org.accounts.revenue}, true, ${actorId})`));
  return { org, planId };
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(new Request("http://subs.test/api/subscriptions/advanced", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
  );

async function versionCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from subscription_plan_versions where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

async function storedComponent(orgId: string): Promise<{ quantity: string; unitPrice: string }> {
  const rows = (await withBypassContext(() => db.execute<{ quantity: string; unitPrice: string }>(
    sql`select quantity::text as "quantity", unit_price::text as "unitPrice"
          from subscription_plan_version_components where org_id = ${orgId} limit 1`,
  ))).rows;
  return { quantity: rows[0]!.quantity, unitPrice: rows[0]!.unitPrice };
}

for (const unitPrice of [undefined, null, ""]) {
  test(`createVersion refuses an omitted unit price (${JSON.stringify(unitPrice)}) with 422 and no draft`, { skip: !DB }, async () => {
    const { org, planId } = await fixture();
    try {
      const component: Record<string, unknown> = { componentKey: "fee", name: "Fee", quantity: "1" };
      if (unitPrice !== undefined) component.unitPrice = unitPrice;
      const response = await post({ action: "createVersion", planId, effectiveFrom: "2026-10-01", components: [component] });
      const json = (await response.json().catch(() => null)) as { error?: string } | null;
      assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
      assert.match(json?.error ?? "", /unit price is required/, `the refusal must name the price: ${JSON.stringify(json)}`);
      assert.equal(await versionCount(org.orgId), 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}

test("createVersion refuses a non-canonical unit price with 422 and no draft", { skip: !DB }, async () => {
  const { org, planId } = await fixture();
  try {
    const response = await post({
      action: "createVersion", planId, effectiveFrom: "2026-10-01",
      components: [{ componentKey: "fee", name: "Fee", quantity: "1", unitPrice: "12,34" }],
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /unit price/, `the refusal must name the price: ${JSON.stringify(json)}`);
    assert.equal(await versionCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('an explicit "0" unit price is accepted as a free component', { skip: !DB }, async () => {
  const { org, planId } = await fixture();
  try {
    const response = await post({
      action: "createVersion", planId, effectiveFrom: "2026-10-01",
      components: [{ componentKey: "fee", name: "Fee", quantity: "1", unitPrice: "0" }],
    });
    assert.equal(response.status, 201, JSON.stringify(await response.json().catch(() => null)));
    assert.deepEqual(await storedComponent(org.orgId), { quantity: "1.0000", unitPrice: "0.0000" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an omitted quantity still defaults to one", { skip: !DB }, async () => {
  const { org, planId } = await fixture();
  try {
    const response = await post({
      action: "createVersion", planId, effectiveFrom: "2026-10-01",
      components: [{ componentKey: "fee", name: "Fee", unitPrice: "10.00" }],
    });
    assert.equal(response.status, 201, JSON.stringify(await response.json().catch(() => null)));
    assert.deepEqual(await storedComponent(org.orgId), { quantity: "1.0000", unitPrice: "10.0000" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("createPlanVersion refuses an omitted unit price without writing", { skip: !DB }, async () => {
  const { org, planId } = await fixture();
  try {
    await assert.rejects(
      withOrgContext(state.orgId, () => createPlanVersion(org.orgId, state.actorId, {
        planId,
        effectiveFrom: "2026-10-01",
        components: [{ componentKey: "fee", name: "Fee", unitPrice: undefined as unknown as string }],
      })),
      /component price/,
    );
    assert.equal(await versionCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
