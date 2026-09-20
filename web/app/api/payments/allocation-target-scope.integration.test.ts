import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Allocation target scope: an open-item id that is malformed must fail closed
 * as a clean 404 (never a Postgres uuid cast error surfacing as a 500), the
 * same boundary the dunning routes and the payment-run bill selection keep —
 * an unresolvable target is indistinguishable from one outside the caller's
 * subsidiary scope.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" }, allowed: new Set<string>() };
Object.assign(globalThis, { __allocationTargetScopeState: state });
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
                user: globalThis.__allocationTargetScopeState.user,
                permissions: new Set(['ap.pay', 'ar.pay']),
                allowedSubsidiaryIds: new Set(globalThis.__allocationTargetScopeState.allowed),
              };
            }
            export function can(authz, permission){ return authz.permissions.has(permission); }
            // Same rule as the real guard: a restricted caller reaches only
            // members of its set; the fixture below always stays in scope.
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
const { createScratchOrg, dropScratchOrg, seedDraftDocument, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { POST } = await import("./post-with-applications/route.ts");

const json = (body: unknown) =>
  new Request("http://audit.local/api/payments/post-with-applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const allocation = (openLineId: string) => ({
  openLineId,
  sourceTransactionAmount: "10.00",
  targetTransactionAmount: "10.00",
  settlementRate: "1",
  settlementRateSource: "same_currency",
  settlementRateReference: "same transaction currency",
});

test("a malformed allocation target id fails closed as 404, never a 500", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const adminId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
    state.user = { orgId: org.orgId, id: adminId };
    const subsidiaryId = (
      await withBypassContext(
        () =>
          db.execute<{ id: string }>(
            sql`select id from subsidiaries where org_id = ${org.orgId} and parent_id is null order by created_at limit 1`,
          ),
      )
    ).rows[0]!.id;
    state.allowed = new Set([subsidiaryId]);
    const documentId = await withBypassContext(() =>
      seedDraftDocument(org.orgId, { kind: "vendor_payment", createdBy: adminId }),
    );
    await withBypassContext(
      () => db.execute(sql`update documents set subsidiary_id = ${subsidiaryId} where id = ${documentId}`),
    );

    for (const openLineId of ["not-a-uuid", "new", "00000000-0000-0000-0000-00000000000"]) {
      const response = await POST(json({ documentId, allocations: [allocation(openLineId)] }));
      assert.equal(response.status, 404, `POST allocations[0].openLineId ${openLineId}`);
      assert.deepEqual(await response.json(), { error: "not found" });
    }
    // A well-formed id that names nothing keeps the sibling's not-found shape.
    const missing = await POST(json({ documentId, allocations: [allocation(randomUUID())] }));
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not found" });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
