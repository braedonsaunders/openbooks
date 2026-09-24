import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * H-QUALSET: the qualification alert schedule is org-wide policy with no
 * subsidiary lineage — one write re-times every entity's expiry alerts at
 * once. POST needs unrestricted subsidiary scope: a restricted
 * hrm.certifications.manage holder gets the named 403 and stores nothing.
 * GET stays open: the schedule and vocabulary disclose no per-subsidiary
 * material, and managers need the lead days to act on alerts. Only identity
 * resolution is doubled; the scope guard, engine writer and database are real.
 */
const state = {
  orgId: "",
  actorId: "",
  allowedSubsidiaryIds: null as ReadonlySet<string> | null,
};
Object.assign(globalThis, { __qualSettingsScopeState: state });
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
      context.parentURL?.includes("/api/hrm/qualification-settings/")
    ) {
      return virtual(`
        export { guardUnrestrictedScope } from ${JSON.stringify(authzUrl)};
        export async function guardPermission() {
          const s = globalThis.__qualSettingsScopeState;
          return {
            user: { orgId: s.orgId, id: s.actorId },
            permissions: new Set(['hrm.certifications.read', 'hrm.certifications.manage']),
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
const { GET, POST } = await import("./route.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  // The engine re-checks the actor's own grant inside the write, so the
  // actor holds the domain permission: the test isolates the scope layer,
  // not the permission layer.
  for (const permission of ["hrm.certifications.read", "hrm.certifications.manage"]) {
    await withBypassContext(() => db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${org.orgId}, ${actorId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'`));
  }
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() => db.execute(sql`
    update orgs
       set settings = jsonb_set(
         jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true),
         '{features,hrmCertifications}', 'true'::jsonb, true)
     where id = ${org.orgId}`));
  return { org };
}

const post = (body: unknown) =>
  POST(
    new Request("http://quals.test/api/hrm/qualification-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

async function storedLeadDays(orgId: string): Promise<number[] | null> {
  const row = (
    await withBypassContext(() =>
      db.execute<{ alert_lead_days: number[] | null }>(sql`
        select alert_lead_days from hrm_qualification_settings where org_id = ${orgId}::uuid`),
    )
  ).rows[0];
  return row?.alert_lead_days ?? null;
}

test("a restricted caller cannot rewrite the org-wide alert schedule", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await post({ leadDays: [30, 7] });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
    assert.equal(await storedLeadDays(org.orgId), null, "a refused write stores no schedule");
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an unrestricted caller writes it; restricted callers still read it", { skip: !DB }, async () => {
  const { org } = await fixture();
  try {
    state.allowedSubsidiaryIds = null;
    const saved = await post({ leadDays: [30, 7] });
    assert.equal(saved.status, 200, JSON.stringify(await saved.json().catch(() => null)));
    assert.deepEqual(await storedLeadDays(org.orgId), [30, 7]);
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const response = await GET();
    assert.equal(response.status, 200);
    const body = (await response.json()) as { settings: { alertLeadDays: number[] } };
    assert.deepEqual(body.settings.alertLeadDays, [30, 7]);
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
