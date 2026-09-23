import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { NextRequest } from "next/server";

/**
 * Forecast snapshots fence the period and the override shape but never bound
 * the override magnitude — and the verb has no catch for the write. A pasted
 * 20-digit override sails through and dies in Postgres as a raw numeric
 * overflow (HTTP 500) instead of failing closed with a named 422 and nothing
 * written. override_amount is numeric(19,4).
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __forecastOverrideState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next-intl/server") return virtual("export async function getTranslations() { return (key) => key }; export async function getLocale() { return 'en' }");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__forecastOverrideState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
      `);
    if (specifier.endsWith("/lib/feature-gates"))
      return virtual(`
        export async function guardFeaturePermission() {
          const s = globalThis.__forecastOverrideState;
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
    db.execute(sql`update orgs set settings = settings || '{"features": {"crm": true}}'::jsonb where id = ${org.orgId}`),
  );
  return { org };
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(new NextRequest("http://forecast.test/api/crm/forecasts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
  );

async function snapshotCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from crm_forecast_snapshots where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

test("forecast snapshots refuse an override wider than numeric(19,4) without writing", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    const response = await post({
      periodStart: "2026-07-01", periodEnd: "2026-09-30",
      overrideAmount: "99999999999999999999.99", snapshotKind: "rep_override", currency: "CAD",
    });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.notEqual(response.status, 500, `expected a named error, got 500: ${JSON.stringify(json)}`);
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.equal(await snapshotCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("forecast snapshots still file an ordinary override", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    const response = await post({
      periodStart: "2026-07-01", periodEnd: "2026-09-30",
      overrideAmount: "123456.78", snapshotKind: "rep_override", currency: "CAD",
    });
    assert.equal(response.status, 201, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await snapshotCount(org.orgId), 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
