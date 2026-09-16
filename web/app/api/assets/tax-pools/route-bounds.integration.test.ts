import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Tax-pool runs shape-check yearStart/yearEnd with a YYYY-MM-DD regex that
 * admits non-calendar days, and integer-check taxYear with no range — so a
 * September 31 or an absurd year sails through every named check and dies in
 * Postgres, surfacing the raw driver failure as the 422 body instead of
 * failing closed with a named error and nothing written.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __taxPoolBoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/feature-gates"))
      return virtual(`
        export async function guardFeaturePermission() {
          const s = globalThis.__taxPoolBoundState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
      `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  return { org };
}

const post = (body: unknown) =>
  withOrgContext(state.orgId, () =>
    POST(new Request("http://pools.test/api/assets/tax-pools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
  );

test("tax-pool run refuses a non-calendar year start without running", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    const response = await post({ taxYear: 2026, yearStart: "2026-09-31", yearEnd: "2026-12-31" });
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /invalid input syntax|Failed query/i);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("tax-pool run still computes an ordinary year", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    const response = await post({ taxYear: 2026 });
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
