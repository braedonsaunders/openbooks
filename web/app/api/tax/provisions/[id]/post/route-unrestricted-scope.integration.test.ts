import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { NextResponse } from "next/server";
Object.assign(globalThis, { __provisionPostOracleNextResponse: NextResponse });

/**
 * H-TAXFILE-ORGWIDE: posting a provision creates and reverses journals for
 * the complete entity set, so it is an org-wide write. A
 * subsidiary-restricted gl.post holder gets the named 403 before any
 * existence lookup — an existing run and a missing id answer identically,
 * and the engine is never reached.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = {
  user: { orgId: "", id: "" },
  permissions: new Set<string>(),
  allowed: null as Set<string> | null,
};
Object.assign(globalThis, { __provisionPostOracleState: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/tax/provisions/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            const NextResponse = globalThis.__provisionPostOracleNextResponse;
            export async function guardPermission(permission){
              if (!globalThis.__provisionPostOracleState.permissions.has(permission)) {
                return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 });
              }
              return {
                user: globalThis.__provisionPostOracleState.user,
                allowedSubsidiaryIds: globalThis.__provisionPostOracleState.allowed,
              };
            }
            export function guardUnrestrictedScope(authz){
              if (authz.allowedSubsidiaryIds === null) return null;
              return NextResponse.json({ error: 'requires unrestricted subsidiary access' }, { status: 403 });
            }
          `),
      };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});

const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { POST } = await import("./route.ts");

const post = (id: string) =>
  POST(new Request("https://openbooks.test/api/tax/provisions/fixture/post", { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

test("provision-post oracle: restricted callers get the named 403 for existing and missing runs", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const adminId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
    state.user = { orgId: org.orgId, id: adminId };
    const runId = randomUUID();
    await withBypassContext(
      () => db.execute(sql`insert into tax_provision_runs(id,org_id,fiscal_year,period_from,period_to,snapshot_hash,payload,created_by,updated_by)
        values (${runId},${org.orgId},2026,'2026-01-01','2026-12-31','hash-1','{}'::jsonb,${adminId},${adminId})`),
    );

    // Restricted gl.post holder: existing and missing ids answer the same
    // named 403 — the scope refusal settles before the existence lookup.
    state.permissions = new Set<string>(["gl.post"]);
    state.allowed = new Set<string>([org.subsidiaryId]);
    const existing = await post(runId);
    assert.equal(existing.status, 403);
    assert.deepEqual(await existing.json(), { error: "requires unrestricted subsidiary access" });
    const missing = await post(randomUUID());
    assert.equal(missing.status, 403);
    assert.deepEqual(await missing.json(), { error: "requires unrestricted subsidiary access" });

    // Without the domain permission the permission check fires first.
    state.permissions = new Set<string>(["reports.read"]);
    const noperm = await post(runId);
    assert.equal(noperm.status, 403);
    assert.deepEqual(await noperm.json(), { error: "missing permission: gl.post" });

    // Unrestricted callers reach the lookup: a missing run is a 404.
    state.permissions = new Set<string>(["gl.post"]);
    state.allowed = null;
    const unrestrictedMissing = await post(randomUUID());
    assert.equal(unrestrictedMissing.status, 404);
    assert.deepEqual(await unrestrictedMissing.json(), { error: "not found" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
