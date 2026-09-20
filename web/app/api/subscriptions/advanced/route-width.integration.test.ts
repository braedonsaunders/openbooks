import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Plan-version creation fences amounts to 4dp shape but never bounds
 * magnitude — and the verb rethrows unknown errors. A pasted 20-digit unit
 * price sails through and dies in Postgres as a raw numeric overflow
 * (HTTP 500) instead of failing closed with a named error and nothing
 * written. Component quantity/unit_price are numeric(19,4).
 */
const root = pathToFileURL(process.cwd() + "/").href;
const engineRoot = new URL("../../../../../engine/", import.meta.url).href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __planVersionWidthState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__planVersionWidthState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['ar.create']), allowedSubsidiaryIds: null };
        }
      `);
    if (specifier.endsWith("/lib/features"))
      return virtual("export async function isFeatureEnabled() { return true }");
    // Bare @openbooks/engine/* resolves cross-checkout to main; pin the worktree copy.
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
    values (${planId}, ${org.orgId}, 'Width Plan', '0', 'CAD', 'monthly', 1, ${org.accounts.revenue}, true, ${actorId})`));
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

const versionBody = (planId: string, unitPrice: string) => ({
  action: "createVersion", planId, effectiveFrom: "2026-07-01",
  components: [{ componentKey: "platform", name: "Platform fee", quantity: "1", unitPrice }],
});

async function versionCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from subscription_plan_versions where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

test("plan versions refuse a unit price wider than numeric(19,4) without writing", { skip: !DB }, async () => {
  const { org, planId } = await fixture();
  try {
    const response = await post(versionBody(planId, "99999999999999999999.99"));
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.notEqual(response.status, 500, `expected a named error, got 500: ${JSON.stringify(json)}`);
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.equal(await versionCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("plan versions still file an ordinary price", { skip: !DB }, async () => {
  const { org, planId } = await fixture();
  try {
    const response = await post(versionBody(planId, "100.00"));
    assert.equal(response.status, 201, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await versionCount(org.orgId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
