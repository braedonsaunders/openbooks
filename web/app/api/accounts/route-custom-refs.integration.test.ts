import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Account create/PATCH validate reference-type custom fields for shape only:
// a foreign-org (or dangling) uuid persists into the tenant jsonb bag while
// native subsidiary/parent references already fail closed org-scoped in the
// same files. Only the session gate is stubbed; handlers and storage are real.
const stateKey = Symbol.for("openbooks.account-custom-refs-test");
const routeState: {
  authz: { user: { orgId: string; id: string }; permissions: Set<string>; allowedSubsidiaryIds: null } | null;
} = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.account-custom-refs-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export async function getAuthz() { return state.authz }
  export function can() { return true }
  export function guardSubsidiaryScope() { return null }
  export function subsidiariesInScope() { return true }
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../lib/authz" || specifier === "../../../../lib/authz") {
      return { url: "mock:authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { POST } = await import("./route.ts");
const { PATCH } = await import("./[id]/route.ts");
const { db, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "account create and PATCH refuse foreign reference custom values",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const foreign = await createScratchOrg();
    try {
      const { adminId } = await seedFlowActors(org.orgId);
      routeState.authz = {
        user: { orgId: org.orgId, id: adminId },
        permissions: new Set(),
        allowedSubsidiaryIds: null,
      };
      await db.execute(sql`
        insert into custom_field_defs
          (id, org_id, target_table, target_kind, key, label, field_type, config, is_required, is_active, created_by, updated_by)
        values
          (${randomUUID()}, ${org.orgId}, 'accounts', null, 'ref_party', 'Reference party', 'reference', '{"referenceTable":"parties"}'::jsonb, false, true, ${adminId}, ${adminId})
      `);
      const post = (key: string, body: unknown) =>
        withOrgContext(org.orgId, () =>
          POST(
            new Request("http://localhost/api/accounts", {
              method: "POST",
              headers: { "content-type": "application/json", "Idempotency-Key": key },
              body: JSON.stringify(body),
            }),
          ),
        );
      // CREATE with a foreign-org reference fails closed and stores nothing.
      const refusedCreate = await post(randomUUID(), {
        name: "Alien ref account",
        type: "asset_other",
        custom: { ref_party: foreign.vendorId },
      });
      assert.equal(
        refusedCreate.status,
        422,
        `expected 422, got ${refusedCreate.status}: ${JSON.stringify(await refusedCreate.clone().json().catch(() => null))}`,
      );
      const created = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from accounts where org_id = ${org.orgId} and name = 'Alien ref account'
      `);
      assert.equal(created.rows[0]?.n ?? -1, 0, "refused create stores nothing");
      // CREATE with an own-org reference still succeeds.
      const okCreate = await post(randomUUID(), {
        name: "Owned ref account",
        type: "asset_other",
        custom: { ref_party: org.vendorId },
      });
      assert.equal(okCreate.status, 201, `expected 201, got ${okCreate.status}: ${JSON.stringify(await okCreate.clone().json().catch(() => null))}`);
      const accountId = ((await okCreate.json()) as { account: { id: string } }).account.id;
      // PATCH swapping in a foreign-org reference fails closed.
      const refusedPatch = await withOrgContext(org.orgId, () =>
        PATCH(
          new Request(`http://localhost/api/accounts/${accountId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ custom: { ref_party: foreign.vendorId } }),
          }),
          { params: Promise.resolve({ id: accountId }) },
        ),
      );
      assert.equal(
        refusedPatch.status,
        422,
        `expected 422, got ${refusedPatch.status}: ${JSON.stringify(await refusedPatch.clone().json().catch(() => null))}`,
      );
      const stored = await db.execute<{ custom: Record<string, unknown> }>(sql`
        select custom from accounts where id = ${accountId}
      `);
      assert.equal(
        (stored.rows[0]?.custom as Record<string, unknown> | undefined)?.ref_party,
        org.vendorId,
        "refused update leaves the stored reference untouched",
      );
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(foreign.orgId);
    }
  },
);
