import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

const state = {
  orgId: "",
  actorId: "",
  allowedSubsidiaryIds: null as ReadonlySet<string> | null,
};
Object.assign(globalThis, { __feedbackSettingsScopeState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
const authzUrl = pathToFileURL(process.cwd() + "/web/lib/authz.ts").href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}");
    if (specifier === "next/headers") return virtual("export function cookies() { throw new Error('no cookies in route test') }");
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/hrm/feedback/settings/")) {
      return virtual(`
        export { guardUnrestrictedScope } from ${JSON.stringify(authzUrl)};
        export async function getAuthz() {
          const s = globalThis.__feedbackSettingsScopeState;
          return {
            user: { orgId: s.orgId, id: s.actorId },
            permissions: new Set(['hrm.performance.manage']),
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
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

test("a subsidiary-restricted HR actor cannot change org-wide feedback policy", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
  try {
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({
        features: { hrm: true, hrmPerformance: true, hrmFeedback: true },
        hrm_feedback: { public_praise_by: "anyone" },
      })}::jsonb where id = ${org.orgId}`));
    const response = await POST(new Request("http://feedback.test/api/hrm/feedback/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicPraiseBy: "managers_and_hr" }),
    }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
    const stored = (await withBypassContext(() => db.execute<{ setting: string }>(sql`
      select settings #>> '{hrm_feedback,public_praise_by}' as setting from orgs where id = ${org.orgId}`))).rows[0]?.setting;
    assert.equal(stored, "anyone", "the refused org-wide policy change must not persist");
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
