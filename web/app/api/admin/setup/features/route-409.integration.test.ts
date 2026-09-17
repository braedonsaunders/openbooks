import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "@openbooks/engine/src/test-fixtures.ts";

// F-t01-015: disabling REST API while MCP access depends on it answers 409
// with no user-visible feedback. Capture the REAL refusal body first so the
// client mapping is hardened against what the server actually sends — not
// against what the code appears to send.

const stateKey = Symbol.for("openbooks.admin-features-409-integration");
const state: {
  authz: {
    user: { orgId: string; id: string; isSuperAdmin: boolean };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
} = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const hooks = registerHooks({
  resolve(specifier, context, next) {
    const virtual = (source: string) => ({
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(source),
    });
    if (specifier === "server-only") return virtual("export {}");
    const parent = String(context.parentURL ?? "");
    if (
      specifier === "../../../../../lib/authz"
      && parent.includes("/api/admin/setup/features/route.ts")
    ) {
      return virtual(`
        const state = globalThis[Symbol.for('openbooks.admin-features-409-integration')];
        export async function guardPermission() { return state.authz; }
      `);
    }
    if (specifier === "./request-org" && parent.includes("/web/lib/auth.ts")) {
      return virtual("export function setRequestOrg() {}");
    }
    return next(specifier, context);
  },
});
const { PUT } = await import("./route");
hooks.deregister();
const skip = !process.env.OPENBOOKS_DB_URL;

async function seed() {
  const seeded = await withBypassContext(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Features actor", "features_actor");
    return { org, actorId };
  });
  state.authz = {
    user: { orgId: seeded.org.orgId, id: seeded.actorId, isSuperAdmin: false },
    permissions: new Set(["admin.setup.manage"]),
    allowedSubsidiaryIds: null,
  };
  return seeded;
}

const put = (body: object) =>
  PUT(
    new Request("http://localhost/api/admin/setup/features", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

async function flags(orgId: string): Promise<Record<string, boolean>> {
  return withBypassContext(async () => (
    await db.execute<{ features: Record<string, boolean> }>(sql`
      select coalesce(settings->'features', '{}'::jsonb) as features from orgs where id = ${orgId}`)
  ).rows[0]!.features ?? {});
}

test("disabling REST API with MCP access on is refused with the typed dependents body", { skip }, async () => {
  const f = await seed();
  try {
    const baseline = await flags(f.org.orgId);
    assert.equal((await put({ features: { apiAccess: true, mcpAccess: true } })).status, 200);
    const enabled = await flags(f.org.orgId);
    assert.equal(enabled.apiAccess, true);
    assert.equal(enabled.mcpAccess, true);
    for (const [key, value] of Object.entries(baseline)) assert.equal(enabled[key], value);

    const refused = await put({ features: { apiAccess: false } });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), {
      error: "feature-dependents-enabled",
      key: "apiAccess",
      dependentKeys: ["mcpAccess"],
    });
    // The refusal is atomic: the flags are untouched.
    assert.deepEqual(await flags(f.org.orgId), enabled);
  } finally {
    state.authz = null;
    await dropScratchOrg(f.org.orgId);
  }
});

test("enabling MCP access with REST API off is refused with the typed dependency body", { skip }, async () => {
  const f = await seed();
  try {
    const baseline = await flags(f.org.orgId);
    const refused = await put({ features: { mcpAccess: true } });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), {
      error: "feature-dependency",
      key: "mcpAccess",
      requiredKeys: ["apiAccess"],
    });
    assert.deepEqual(await flags(f.org.orgId), baseline);
  } finally {
    state.authz = null;
    await dropScratchOrg(f.org.orgId);
  }
});
