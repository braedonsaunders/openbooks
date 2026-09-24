import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * H-COMPSET: the compensation document is org-wide policy with no subsidiary
 * lineage — one write re-tunes every entity's gap analysis and burdened
 * costing at once. PUT needs unrestricted subsidiary scope: a restricted
 * hrm.compensation.manage holder gets the named 403 and stores nothing.
 * GET stays open: the five fields are policy scalars disclosing no
 * per-subsidiary material. Only the gate is doubled; the feature check,
 * writer and database are real.
 */
const state = {
  orgId: "",
  actorId: "",
  allowedSubsidiaryIds: null as ReadonlySet<string> | null,
};
Object.assign(globalThis, { __compSettingsScopeState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
const authzUrl = pathToFileURL(process.cwd() + "/web/lib/authz.ts").href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation")
      return virtual("export function redirect() {}; export function notFound() {}");
    if (specifier === "next/headers")
      return virtual("export function cookies() { throw new Error('no cookies in route test') }");
    if (
      specifier.endsWith("/lib/authz") &&
      context.parentURL?.includes("/api/hrm/compensation-settings/")
    ) {
      // Only identity resolution is doubled; the scope guard is the real
      // one, re-exported — never a second implementation.
      return virtual(`
        export { guardUnrestrictedScope } from ${JSON.stringify(authzUrl)};
        export async function guardPermission() {
          const s = globalThis.__compSettingsScopeState;
          return {
            user: { orgId: s.orgId, id: s.actorId },
            permissions: new Set(['hrm.compensation.read', 'hrm.compensation.manage']),
            allowedSubsidiaryIds: s.allowedSubsidiaryIds,
          };
        }
      `);
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { GET, PUT } = await import("./route.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() => db.execute(sql`
    update orgs
       set settings = jsonb_set(
         jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true),
         '{features,hrmCompensation}', 'true'::jsonb, true)
     where id = ${org.orgId}`));
  return { org };
}

const put = (body: unknown) =>
  PUT(
    new Request("http://comp.test/api/hrm/compensation-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

async function storedCompensation(orgId: string): Promise<Record<string, unknown> | null> {
  const row = (
    await withBypassContext(() =>
      db.execute<{ settings: Record<string, unknown> | null }>(sql`
        select settings->'compensation' as settings from orgs where id = ${orgId}`),
    )
  ).rows[0];
  return row?.settings ?? null;
}

test("a restricted caller cannot rewrite org-wide compensation policy", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await put({ gapThresholdPct: 5, burdenRate: "1.25" });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
    assert.equal(await storedCompensation(org.orgId), null, "a refused write stores no policy");
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an unrestricted caller writes it; restricted callers still read it", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    state.allowedSubsidiaryIds = null;
    const saved = await put({ gapThresholdPct: 5, burdenRate: "1.25" });
    assert.equal(saved.status, 200, JSON.stringify(await saved.json().catch(() => null)));
    assert.deepEqual(await storedCompensation(org.orgId), { gapThresholdPct: 5, burdenRate: "1.25" });
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await GET();
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()) as unknown, {
      settings: { gapThresholdPct: 5, burdenRate: "1.25" },
    });
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
