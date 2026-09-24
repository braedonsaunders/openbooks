import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for H-PROJCHARGE: POST /api/project-charges
// requires only projects.manage at the boundary, then createProjectCharge
// submits and posts the GL-family direct-post kind (DR project COGS / CR
// cost pool). A projects.manage-only role must never advance a charge past
// draft: without the kind's postPermission (gl.post — the same map the
// generic document actions route enforces) the charge is saved as a draft
// carrying the named refusal. With gl.post the identical request flows
// through submission as before. Only authz is doubled; the route, the
// charge service, and Postgres are real.
const stateKey = Symbol.for("openbooks.project-charge-post-permission-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.project-charge-post-permission-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  // The permission SETS under test are real data (a projects.manage-only set
  // versus one that also holds gl.post); only the check itself is doubled,
  // with the wildcard semantics the real check applies.
  export function can(authz, perm) {
    const perms = authz.permissions
    if (!perms) return false
    if (perms.has('*') || perms.has(perm)) return true
    return perms.has(String(perm).split('.')[0] + '.*')
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "next/navigation") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export function redirect() {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (
      specifier === "../../../lib/authz" &&
      context.parentURL?.includes("/api/project-charges/")
    ) {
      return { url: "mock:project-charge-post-permission-authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:project-charge-post-permission-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?project-charge-post-permission-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, env, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

interface Fixture {
  orgId: string;
  actorId: string;
  projectId: string;
  itemId: string;
}

async function seed(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"projects": true}'::jsonb)
     where id = ${org.orgId}`);
  const projectId = (await db.execute<{ id: string }>(sql`
    insert into projects (org_id, name, is_active)
    values (${org.orgId}, 'Charge Project', true)
    returning id`)).rows[0]!.id;
  await db.execute(sql`
    update items set expense_account_id = ${org.accounts.cogs}
     where id = ${org.items.service} and org_id = ${org.orgId}`);
  return { orgId: org.orgId, actorId, projectId, itemId: org.items.service };
}

async function postAs(
  fixture: Fixture,
  permissions: string[],
): Promise<{ status: number; json: Record<string, unknown> }> {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  };
  try {
    const response = await withOrgContext(fixture.orgId, () => POST(
      new Request("http://openbooks.test/api/project-charges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: fixture.projectId,
          // Zero-cost line: posting is skipped for a zero total, so the
          // observable contrast is submission — released (approved) versus
          // never submitted (draft). A denied caller must never reach the
          // submit/post lifecycle at all.
          lines: [{ itemId: fixture.itemId, quantity: "1", costRate: "0", billRate: "0" }],
        }),
      }),
    ));
    return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> };
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } };
  }
}

async function chargeStatus(orgId: string, id: string): Promise<string | null> {
  const rows = (await withOrgContext(orgId, () => db.execute<{ status: string }>(sql`
    select status from documents where org_id = ${orgId} and id = ${id}`))).rows;
  return rows[0]?.status ?? null;
}

test("POST with projects.manage but no gl.post saves a draft and names gl.post", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fixture = await withBypass(seed);
  try {
    const result = await postAs(fixture, ["projects.manage", "projects.read"]);
    assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.json)}`);
    assert.equal(result.json.posted, false);
    assert.match(String(result.json.postRefusal), /gl\.post/);
    assert.equal(await chargeStatus(fixture.orgId, String(result.json.id)), "draft");
  } finally {
    await withBypass(() => dropScratchOrg(fixture.orgId));
  }
});

test("POST with gl.post flows through submission as before", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const fixture = await withBypass(seed);
  try {
    const result = await postAs(fixture, ["projects.manage", "projects.read", "gl.post"]);
    assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.json)}`);
    assert.equal(result.json.postRefusal, undefined);
    // Ungated submission releases the zero-total charge to approved; a zero
    // total posts nothing, so approved (not draft) is the flowing outcome.
    assert.equal(await chargeStatus(fixture.orgId, String(result.json.id)), "approved");
  } finally {
    await withBypass(() => dropScratchOrg(fixture.orgId));
  }
});
