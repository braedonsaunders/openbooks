import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = pathToFileURL(process.cwd() + "/").href;
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/src/test-fixtures.ts";
import type { Authz } from "../../../../../lib/authz";

// Manually running a script looks the row up by path id. A malformed id must
// be the same clean 404 as an unknown script — never a PostgreSQL uuid cast
// error escaping as a 500. Only identity is substituted; feature checks,
// routes, domain services and SQL are native.
const enabled = !!process.env.OPENBOOKS_DB_URL;
const identity: { gate: Authz | null } = { gate: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.script-run-id")] = identity;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "./authz" && (context.parentURL ?? "").endsWith("/lib/feature-gates.ts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(
          "export async function guardPermission(){return globalThis[Symbol.for('openbooks.script-run-id')].gate}",
        ),
      };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { POST } = await import("./run/route");
const { PATCH } = await import("../route");
const { DELETE } = await import("./route");

const validScript = (id: unknown) => ({
  id,
  name: "Nightly review",
  triggerPoint: "bulk",
  source: "function main(ctx) { return {}; }",
  documentKind: null,
});
const patchJson = (body: unknown) =>
  new Request("https://openbooks.test/api/admin/scripts", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function fixtureOrg() {
  const org = await createScratchOrg();
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"scripts":true}'::jsonb) where id=${org.orgId}`);
  identity.gate = {
    user: { orgId: org.orgId, id: org.orgId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  } as Authz;
  return org;
}

test("script run-now returns 404 for a malformed script id", { skip: !enabled }, async () => {
  const org = await fixtureOrg();
  try {
    for (const id of ["not-a-uuid", "new"]) {
      const response = await POST(new Request(`https://openbooks.test/api/admin/scripts/${id}/run`, { method: "POST" }), {
        params: Promise.resolve({ id }),
      });
      assert.equal(response.status, 404, `POST run ${id}`);
    }
  } finally {
    identity.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("script PATCH and DELETE return 404 for a malformed script id", { skip: !enabled }, async () => {
  const org = await fixtureOrg();
  try {
    for (const id of ["not-a-uuid", "new"]) {
      const patched = await PATCH(patchJson(validScript(id)));
      assert.equal(patched.status, 404, `PATCH ${id}`);
      const deleted = await DELETE(
        new Request(`https://openbooks.test/api/admin/scripts/${id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id }) },
      );
      assert.equal(deleted.status, 404, `DELETE ${id}`);
    }
  } finally {
    identity.gate = null;
    await dropScratchOrg(org.orgId);
  }
});
