import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * H-FINCHANGE: the domain permission must be checked BEFORE the row lookup.
 * A caller holding none of the change-family permissions (assets.manage,
 * ar.post, close.run) gets the same uniform 404 for an existing change and
 * a missing id — never a 403 naming the needed permission. Submit, apply
 * and reverse share authorizeChange.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = {
  user: { orgId: "", id: "" },
  permissions: new Set<string>(),
};
Object.assign(globalThis, { __finchangeOracleState: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/accounting/changes/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function getAuthz(){
              return {
                user: globalThis.__finchangeOracleState.user,
                permissions: new Set(globalThis.__finchangeOracleState.permissions),
                allowedSubsidiaryIds: null,
              };
            }
            export function can(authz, permission){ return authz.permissions.has(permission); }
          `),
      };
    }
    if (specifier.endsWith("/lib/features") && context.parentURL?.includes("/accounting/changes/")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(`export async function isFeatureEnabled(){ return true; }`),
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
const { authorizeChange } = await import("./_authorization.ts");
import { NextResponse } from "next/server";

test("financial-change oracle: no family permission sees existing and missing ids identically", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const adminId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
    state.user = { orgId: org.orgId, id: adminId };
    const changeId = randomUUID();
    await withBypassContext(
      () => db.execute(sql`insert into financial_changes(id,org_id,subsidiary_id,domain,subject_id,operation,effective_on,reason,idempotency_key,payload,before_state,submitted_by,created_by,updated_by)
        values (${changeId},${org.orgId},${org.subsidiaryId},'revenue',${randomUUID()},'test-op','2026-01-01','test reason',${`key-${changeId}`},'{}'::jsonb,'{}'::jsonb,${adminId},${adminId},${adminId})`),
    );

    // Caller with none of the family permissions: uniform 404 both ways.
    state.permissions = new Set<string>(["reports.read"]);
    const existing = await authorizeChange(changeId);
    assert.ok(existing instanceof NextResponse);
    assert.equal(existing.status, 404);
    assert.deepEqual(await existing.json(), { error: "change not found" });
    const missing = await authorizeChange(randomUUID());
    assert.ok(missing instanceof NextResponse);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "change not found" });

    // Caller holding the matching domain permission passes the family gate.
    state.permissions = new Set<string>(["ar.post"]);
    const allowed = await authorizeChange(changeId);
    assert.ok(!(allowed instanceof NextResponse));

    // Wrong-domain callers learn nothing: an ar.post-only caller sees an
    // existing lease change exactly like a missing id (uniform 404).
    const leaseId = randomUUID();
    await withBypassContext(
      () => db.execute(sql`insert into financial_changes(id,org_id,subsidiary_id,domain,subject_id,operation,effective_on,reason,idempotency_key,payload,before_state,submitted_by,created_by,updated_by)
        values (${leaseId},${org.orgId},${org.subsidiaryId},'lease',${randomUUID()},'test-op','2026-01-01','test reason',${`key-${leaseId}`},'{}'::jsonb,'{}'::jsonb,${adminId},${adminId},${adminId})`),
    );
    const wrongDomain = await authorizeChange(leaseId);
    assert.ok(wrongDomain instanceof NextResponse);
    assert.equal(wrongDomain.status, 404);
    assert.deepEqual(await wrongDomain.json(), { error: "change not found" });
    const wrongDomainMissing = await authorizeChange(randomUUID());
    assert.ok(wrongDomainMissing instanceof NextResponse);
    assert.equal(wrongDomainMissing.status, 404);
    assert.deepEqual(await wrongDomainMissing.json(), { error: "change not found" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
