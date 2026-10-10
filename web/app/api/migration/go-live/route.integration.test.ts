import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The guided cutover records go-live through the governed command, never
// around it: a missing cutover date, an open required check, and a second
// recording all refuse with the native remedy. This test drives the REAL
// handler (only the session gate is stubbed) against a scratch organization.

const stateKey = Symbol.for("openbooks.migration-go-live-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const module_ = (source: string): { shortCircuit: true; format: "module"; url: string } => ({
  shortCircuit: true,
  format: "module",
  url: `data:text/javascript,${encodeURIComponent(source)}`,
});

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/authz") {
      const real = nextResolve(specifier, context).url;
      const nextServer = nextResolve("next/server", context).url;
      return module_(`
        export * from ${JSON.stringify(real)};
        const state = globalThis[Symbol.for('openbooks.migration-go-live-route-test')];
        const { NextResponse } = await import(${JSON.stringify(nextServer)});
        export async function guardPermission(_permission) {
          if (!state.authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
          return { permissions: new Set(), allowedSubsidiaryIds: null, ...state.authz };
        }
      `);
    }
    return nextResolve(specifier, context);
  },
});

const { POST } = (await import("./route.ts?migration-go-live")) as typeof import("./route.ts");

const { withBypassContext, withOrgTransaction, db, env } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { resolveAuthzByUserId } = await import("@/lib/authz");
const { readMigrationPlan, updateMigrationPlan } = await import("@/lib/migration/plan");

const skip = !env.OPENBOOKS_DB_URL;

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/migration/go-live", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("go-live refuses without a cutover date and while a required check is open", { skip, timeout: 180_000 }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId));
    await withOrgTransaction(org.orgId, () => db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`));
    const authz = await withOrgTransaction(org.orgId, () => resolveAuthzByUserId(org.orgId, adminId));
    assert.ok(authz);
    routeState.authz = authz;
    const inOrg = <T>(fn: () => Promise<T>) => withOrgTransaction(org.orgId, fn);
    await inOrg(() => updateMigrationPlan({ orgId: org.orgId, id: adminId }, { path: "spreadsheet", sourceSystem: "spreadsheet" }, "test plan"));

    const dateless = await POST(postRequest({ confirmation: "the books are verified" }));
    assert.equal(dateless.status, 409);
    assert.match(((await dateless.json()) as { error: string }).error, /cutover date/);

    await inOrg(() => updateMigrationPlan({ orgId: org.orgId, id: adminId }, { cutoverDate: "2026-10-01" }, "test plan"));
    const blocked = await POST(postRequest({ confirmation: "the books are verified" }));
    assert.equal(blocked.status, 409);
    assert.match(((await blocked.json()) as { error: string }).error, /openingJournalPosted/);
    assert.equal((await inOrg(() => readMigrationPlan(org.orgId))).goLive, null, "a refused go-live records nothing");
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});
