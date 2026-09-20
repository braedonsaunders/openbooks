import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for POST /api/admin/setup/overhead action=apply.
// The publish branch already requires a real calendar date (s14); apply
// shape-checked effectiveFrom with a bare YYYY-MM-DD regex, so an impossible
// date ('2026-02-30') reached the profile-version lateral query, whose ::date
// casts throw a raw driver error surfaced as a 422 with a Postgres message
// instead of the route's 400 field error.

const stateKey = Symbol.for("openbooks.overhead-apply-date-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.overhead-apply-date-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export function can(authz, permission) {
    const permissions = authz?.permissions ?? new Set()
    if (permissions.has('*')) return true
    if (permissions.has(permission)) return true
    const ns = permission.split('.')[0]
    return permissions.has(ns + '.*')
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (specifier === "../../../../../lib/authz" && context.parentURL?.includes("setup/overhead")) {
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

const routeUrl = "./route.ts?overhead-apply-date-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

async function seed(): Promise<{ orgId: string; actorId: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Overhead Admin", "admin"));
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ projects: true })}::jsonb)
     where id = ${org.orgId}`));
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  return { orgId: org.orgId, actorId };
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/setup/overhead", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

test(
  "apply rejects an impossible calendar date with a 400 field error",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { orgId } = await seed();
    const res = await withOrgContext(orgId, () =>
      POST(
        postRequest({
          action: "apply",
          projectTypeIds: [randomUUID()],
          overhead: { method: "none" },
          effectiveFrom: "2026-02-30",
          reason: "test",
        }),
      ),
    );
    assert.equal(res.status, 400);
    assert.match(String((await res.json()).error), /effectiveFrom/);
  },
);

test(
  "apply still reaches the profile lookup for a real calendar date",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { orgId } = await seed();
    const res = await withOrgContext(orgId, () =>
      POST(
        postRequest({
          action: "apply",
          projectTypeIds: [randomUUID()],
          overhead: { method: "none" },
          effectiveFrom: "2026-03-31",
          reason: "test",
        }),
      ),
    );
    assert.equal(res.status, 422);
    assert.match(String((await res.json()).error), /project type not found/);
  },
);
