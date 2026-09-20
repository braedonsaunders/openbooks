import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * The costing PUT shape-checks money with canonicalDecimal (4dp) but never
 * fences whole-digit width — so a pasted 20-digit standard cost sails
 * through the 'invalid' check and dies in Postgres on the profile upsert,
 * surfacing the raw driver failure as the 422 body instead of failing
 * closed with a named error and nothing written. standard_cost (and its
 * sibling money columns) are numeric(19,4).
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __itemCostingBoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/feature-gates"))
      return virtual(`
        export async function guardFeaturePermission() {
          const s = globalThis.__itemCostingBoundState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
      `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { GET, PUT } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fx {
  orgId: string;
  itemId: string;
  asset: string;
  cogs: string;
  adjustment: string;
  clearing: string;
}

async function fixture(): Promise<Fx> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,inventory}', 'true'::jsonb, true) where id = ${org.orgId}`),
  );
  return {
    orgId: org.orgId,
    itemId: org.items.fifo,
    asset: org.accounts.invAsset,
    cogs: org.accounts.cogs,
    adjustment: org.accounts.adjustment,
    clearing: org.accounts.clearing,
  };
}

const call = (fn: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>, itemId: string, body?: unknown) =>
  withOrgContext(state.orgId, () =>
    fn(
      new Request(`http://costing.test/api/items/${itemId}/costing`, {
        method: body === undefined ? "GET" : "PUT",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: itemId }) },
    ),
  );

async function profile(fx: Fx) {
  const response = await call(GET, fx.itemId);
  const json = (await response.json().catch(() => null)) as {
    profile: { updated_at: string; standard_cost: string | null };
  } | null;
  assert.equal(response.status, 200, JSON.stringify(json));
  return json!.profile;
}

const putBody = (fx: Fx, token: string, standardCost: string) => ({
  costingMethod: "fifo",
  tracking: "none",
  assetAccountId: fx.asset,
  cogsAccountId: fx.cogs,
  adjustmentAccountId: fx.adjustment,
  varianceAccountId: fx.adjustment,
  receivedNotBilledAccountId: fx.clearing,
  baseUnit: "ea",
  standardCost,
  expectedUpdatedAt: token,
});

test("costing refuses a standard cost wider than numeric(19,4) without writing", { skip: !DB }, async () => {
  const fx = await fixture();
  try {
    const before = await profile(fx);
    const response = await call(PUT, fx.itemId, putBody(fx, before.updated_at, "99999999999999999999.99"));
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /numeric field overflow|Failed query/i);
    const after = await profile(fx);
    assert.equal(after.standard_cost, before.standard_cost);
    assert.equal(after.updated_at, before.updated_at);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("costing still saves an ordinary standard cost", { skip: !DB }, async () => {
  const fx = await fixture();
  try {
    const before = await profile(fx);
    const response = await call(PUT, fx.itemId, putBody(fx, before.updated_at, "12.50"));
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    const after = await profile(fx);
    assert.ok(Number(after.standard_cost) === 12.5, `standard cost not saved: ${after.standard_cost}`);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});
