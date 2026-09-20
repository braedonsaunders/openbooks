import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * PSP settlement boundary: a malformed batch id on post/reverse must fail
 * closed as a clean 404 (never a Postgres uuid cast error surfacing as a
 * 500) — the same boundary the payment, view, and report-definition routes
 * keep for restricted callers.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" }, allowed: new Set<string>() };
Object.assign(globalThis, { __pspSettlementScopeState: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/api/json") {
      return next(root + "web/lib/api/json.ts", context);
    }
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/psp/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function getAuthz(){
              return {
                user: globalThis.__pspSettlementScopeState.user,
                permissions: new Set(['banking.reconcile']),
                allowedSubsidiaryIds: new Set(globalThis.__pspSettlementScopeState.allowed),
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
    if (specifier.endsWith("/lib/features") && context.parentURL?.includes("/api/psp/")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function isFeatureEnabled(){ return true; } export async function subsidiaryFeatureEnabled(){ return true; }",
      };
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { POST } = await import("./route.ts");

const json = (body: unknown) =>
  new Request("http://audit.local/api/psp/settlements", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("post/reverse answer a malformed batch id with 404, never a 500", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    const subsidiaryId = (
      await withBypassContext(
        () =>
          db.execute<{ id: string }>(
            sql`select id from subsidiaries where org_id = ${org.orgId} and parent_id is null order by created_at limit 1`,
          ),
      )
    ).rows[0]!.id;
    state.allowed = new Set([subsidiaryId]);
    for (const body of [
      { action: "post", batchId: "not-a-uuid" },
      { action: "reverse", batchId: "not-a-uuid", reversalDate: "2026-02-01", reason: "duplicate" },
    ]) {
      const response = await POST(json(body));
      assert.equal(response.status, 404, `${body.action} not-a-uuid`);
      assert.deepEqual(await response.json(), { error: "not found" });
    }
    // A well-formed id that names nothing keeps the miss shape.
    const missing = await POST(json({ action: "post", batchId: randomUUID() }));
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not found" });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
