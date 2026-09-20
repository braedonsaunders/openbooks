import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Item rate saves shape-check effectiveFrom with a YYYY-MM-DD regex that
 * admits non-calendar days, and fence tier amounts only to decimal shape —
 * so a September 31 or a pasted 20-digit bill rate sails through every named
 * check and dies in Postgres, surfacing the raw driver failure as the 422
 * body instead of failing closed with a named error and nothing written.
 * effective_from is date; bill_rate/cost_rate are numeric(19,4).
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __itemRatesBoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/feature-gates"))
      return virtual(`
        export async function guardFeaturePermission() {
          const s = globalThis.__itemRatesBoundState;
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
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings = settings || '{"features": {"projects": true}}'::jsonb where id = ${org.orgId}`),
  );
  return { org };
}

const post = (itemId: string, body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(
      new Request(`http://rates.test/api/items/${itemId}/rates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: itemId }) },
    ),
  );

const body = (effectiveFrom: string, billRate: string) => ({
  effectiveFrom, baseUnit: "hour", pricingPolicy: "capped_ladder",
  tiers: [{ unitCode: "hour", unitName: "Hour", baseQuantity: "1", costRate: "75", billRate }],
});

async function profileCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from item_rate_profiles where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

test("item rates refuse a non-calendar effective date without writing", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    const response = await post(org.items.service, body("2026-09-31", "125"));
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /invalid input syntax|Failed query/i);
    assert.equal(await profileCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("item rates refuse a bill rate wider than numeric(19,4) without writing", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    const response = await post(org.items.service, body("2026-07-01", "99999999999999999999.99"));
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /numeric field overflow|Failed query/i);
    assert.equal(await profileCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("item rates still file an ordinary version", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    const response = await post(org.items.service, body("2026-07-01", "125"));
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await profileCount(org.orgId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
