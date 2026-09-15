import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/src/test-fixtures.ts";
import type { Authz } from "../../../../lib/authz";

// Capitalizing an equipment unit binds the path id into a uuid column. A
// malformed id must be the same clean 404 as an unknown unit — never a
// PostgreSQL uuid cast error escaping as a 500. Only identity is
// substituted; feature checks, routes, domain services and SQL are native.
const enabled = !!process.env.OPENBOOKS_DB_URL;
const identity: { gate: Authz | null } = { gate: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.equipment-capitalize-id")] = identity;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/lib/api/json") return next(new URL("../../../../lib/api/json.ts", import.meta.url).href, context);
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "./authz" && (context.parentURL ?? "").endsWith("/lib/feature-gates.ts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(
          "export async function guardPermission(){return globalThis[Symbol.for('openbooks.equipment-capitalize-id')].gate}",
        ),
      };
    }
    return next(specifier, context);
  },
});
const { POST } = await import("./capitalize/route");
const { DELETE } = await import("./route");

test("equipment capitalization returns 404 for a malformed unit id", { skip: !enabled }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"equipment":true,"fixedAssets":true}'::jsonb) where id=${org.orgId}`);
    identity.gate = {
      user: { orgId: org.orgId, id: org.orgId },
      permissions: new Set(["*"]),
      allowedSubsidiaryIds: null,
    } as Authz;
    for (const id of ["not-a-uuid", "new"]) {
      const response = await POST(new Request(`https://openbooks.test/api/equipment/${id}/capitalize`, { method: "POST" }), {
        params: Promise.resolve({ id }),
      });
      assert.equal(response.status, 404, `POST capitalize ${id}`);

      const deleted = await DELETE(new Request(`https://openbooks.test/api/equipment/${id}`, { method: "DELETE" }), {
        params: Promise.resolve({ id }),
      });
      assert.equal(deleted.status, 404, `DELETE equipment ${id}`);
    }
  } finally {
    identity.gate = null;
    await dropScratchOrg(org.orgId);
  }
});
