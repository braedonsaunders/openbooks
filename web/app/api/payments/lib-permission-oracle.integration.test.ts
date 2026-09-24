import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * H-PAYRUN: the domain permission must be checked BEFORE the row lookup.
 * A caller holding neither ap.pay nor ar.pay gets the same uniform 404 for
 * an existing run and a missing id — never a 403 naming the permission.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = {
  user: { orgId: "", id: "" },
  permissions: new Set<string>(),
  allowed: null as Set<string> | null,
};
Object.assign(globalThis, { __payrunOracleState: state });
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
                user: globalThis.__payrunOracleState.user,
                permissions: new Set(globalThis.__payrunOracleState.permissions),
                allowedSubsidiaryIds: globalThis.__payrunOracleState.allowed,
              };
            }
            export function can(authz, permission){ return authz.permissions.has(permission); }
            export function guardSubsidiaryScope(){ return null; }
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
const { guardPaymentRunPermission } = await import("./lib.ts");
import { NextResponse } from "next/server";

test("payment-run oracle: no pay permission sees existing and missing ids identically", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const adminId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
    state.user = { orgId: org.orgId, id: adminId };
    state.allowed = null;
    const runId = randomUUID();
    await withBypassContext(
      () => db.execute(sql`insert into payment_runs(id,org_id,run_number,bank_account_id,subsidiary_id,method,direction,currency,created_by)
        values (${runId},${org.orgId},'ORACLE-RUN',${org.accounts.bank},${org.subsidiaryId},'wire','outbound','USD',${adminId})`),
    );
    // Caller with neither direction permission: uniform 404 both ways.
    state.permissions = new Set<string>(["payments.read"]);
    const existing = await guardPaymentRunPermission(runId);
    assert.ok(existing instanceof NextResponse);
    assert.equal(existing.status, 404);
    assert.deepEqual(await existing.json(), { error: "not found" });
    const missingId = randomUUID();
    const missing = await guardPaymentRunPermission(missingId);
    assert.ok(missing instanceof NextResponse);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not found" });

    // Caller holding the matching direction passes the family gate.
    state.permissions = new Set<string>(["ap.pay"]);
    const allowed = await guardPaymentRunPermission(runId);
    assert.ok(!(allowed instanceof NextResponse));

    // Wrong-direction callers learn nothing: an ap.pay-only caller sees an
    // existing inbound run exactly like a missing id (uniform 404).
    const inboundId = randomUUID();
    await withBypassContext(
      () => db.execute(sql`insert into payment_runs(id,org_id,run_number,bank_account_id,subsidiary_id,method,direction,purpose,currency,created_by)
        values (${inboundId},${org.orgId},'ORACLE-IN',${org.accounts.bank},${org.subsidiaryId},'direct_debit','inbound','customer_collections','USD',${adminId})`),
    );
    const wrongDir = await guardPaymentRunPermission(inboundId);
    assert.ok(wrongDir instanceof NextResponse);
    assert.equal(wrongDir.status, 404);
    assert.deepEqual(await wrongDir.json(), { error: "not found" });
    const wrongDirMissing = await guardPaymentRunPermission(randomUUID());
    assert.ok(wrongDirMissing instanceof NextResponse);
    assert.equal(wrongDirMissing.status, 404);
    assert.deepEqual(await wrongDirMissing.json(), { error: "not found" });

    // Symmetrically, an ar.pay-only caller sees an existing outbound run
    // exactly like a missing id.
    state.permissions = new Set<string>(["ar.pay"]);
    const outboundDenied = await guardPaymentRunPermission(runId);
    assert.ok(outboundDenied instanceof NextResponse);
    assert.equal(outboundDenied.status, 404);
    assert.deepEqual(await outboundDenied.json(), { error: "not found" });
    const outboundMissing = await guardPaymentRunPermission(randomUUID());
    assert.ok(outboundMissing instanceof NextResponse);
    assert.equal(outboundMissing.status, 404);
    assert.deepEqual(await outboundMissing.json(), { error: "not found" });
    // And the matching inbound direction passes.
    const inboundAllowed = await guardPaymentRunPermission(inboundId);
    assert.ok(!(inboundAllowed instanceof NextResponse));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
