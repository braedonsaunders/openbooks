import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * H-PAYDOC: the domain permission must be checked BEFORE the row lookup.
 * A caller holding neither ap.pay nor ar.pay gets the same uniform 404 for
 * an existing payment document and a missing id — never a 403 naming the
 * needed permission. Every verb (GET/PATCH/DELETE) shares gateForDocument.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = {
  user: { orgId: "", id: "" },
  permissions: new Set<string>(),
  allowed: null as Set<string> | null,
};
Object.assign(globalThis, { __paydocOracleState: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/payments/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function getAuthz(){
              return {
                user: globalThis.__paydocOracleState.user,
                permissions: new Set(globalThis.__paydocOracleState.permissions),
                allowedSubsidiaryIds: globalThis.__paydocOracleState.allowed,
              };
            }
            export function can(authz, permission){ return authz.permissions.has(permission); }
            export function guardSubsidiaryScope(authz, subsidiaryId, opts = {}){
              const allowed = authz.allowedSubsidiaryIds;
              if (allowed === null) return null;
              if (subsidiaryId != null && allowed.has(subsidiaryId)) return null;
              if (subsidiaryId == null && opts.orgWideNull) return null;
              return { status: 404, json: async () => ({ error: 'not found' }) };
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
const { createScratchOrg, dropScratchOrg, seedFlowActors, seedDraftDocument } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { GET } = await import("./route.ts");

test("payment-document oracle: no pay permission sees existing and missing ids identically", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const adminId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
    state.user = { orgId: org.orgId, id: adminId };
    state.allowed = null;
    const documentId = await withBypassContext(() =>
      seedDraftDocument(org.orgId, { kind: "vendor_payment", createdBy: adminId }),
    );
    await withBypassContext(
      () => db.execute(sql`update documents set subsidiary_id = ${org.subsidiaryId} where id = ${documentId}`),
    );

    // Caller with neither direction permission: uniform 404 both ways.
    state.permissions = new Set<string>(["payments.read"]);
    const existing = await GET(new Request("https://openbooks.test/api/payments/fixture"), {
      params: Promise.resolve({ id: documentId }),
    });
    assert.equal(existing.status, 404);
    assert.deepEqual(await existing.json(), { error: "not found" });
    const missing = await GET(new Request("https://openbooks.test/api/payments/fixture"), {
      params: Promise.resolve({ id: randomUUID() }),
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not found" });

    // Wrong-direction callers learn nothing: an ar.pay-only caller sees the
    // existing vendor payment exactly like a missing id (uniform 404).
    state.permissions = new Set<string>(["ar.pay"]);
    const wrongDir = await GET(new Request("https://openbooks.test/api/payments/fixture"), {
      params: Promise.resolve({ id: documentId }),
    });
    assert.equal(wrongDir.status, 404);
    assert.deepEqual(await wrongDir.json(), { error: "not found" });
    const wrongDirMissing = await GET(new Request("https://openbooks.test/api/payments/fixture"), {
      params: Promise.resolve({ id: randomUUID() }),
    });
    assert.equal(wrongDirMissing.status, 404);
    assert.deepEqual(await wrongDirMissing.json(), { error: "not found" });

    // The matching direction passes the gate and the draft document loads.
    state.permissions = new Set<string>(["ap.pay"]);
    const matched = await GET(new Request("https://openbooks.test/api/payments/fixture"), {
      params: Promise.resolve({ id: documentId }),
    });
    assert.equal(matched.status, 200);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
