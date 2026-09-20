import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Permission-key regression for PUT /api/admin/navigation: the catalogue and
// the admin hub both name `admin.nav.manage` ("Customize navigation") as the
// key for this surface, so a holder of that key — and only an admin-key
// holder — may save. Unlike route.integration.test.ts (whose mock waves every
// key through), this mock enforces the requested key with the REAL
// permissionSetCovers, so the suite proves which key the route demands.
const stateKey = Symbol.for("openbooks.nav-permission-test");
interface PermState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const permState: PermState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = permState;

const mockAuthz = `
  import { NextResponse } from 'next/server';
  import { permissionSetCovers } from '@openbooks/engine/src/organization/permissions.ts';
  const state = globalThis[Symbol.for('openbooks.nav-permission-test')]
  export async function guardPermission(permission) {
    if (!state.authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    if (!permissionSetCovers(state.authz.permissions, permission)) {
      return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 });
    }
    return state.authz;
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("admin/navigation")) {
      return { url: "mock:nav-permission-authz", shortCircuit: true };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      const testUrl = import.meta.url;
      const webRoot = testUrl.slice(0, testUrl.indexOf("/web/") + 5);
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context);
    }
    if (context.parentURL?.startsWith("mock:") && (specifier.startsWith("@openbooks/") || specifier === "next/server")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:nav-permission-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?nav-permission-test";
const { PUT } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const CONFIG = {
  version: 2,
  groups: [
    {
      id: "work",
      label: "Work",
      items: [
        { kind: "module", moduleKey: "dashboard" },
        { kind: "module", moduleKey: "ar-invoices" },
      ],
    },
  ],
};

function putRequest(config: unknown): Request {
  return new Request("http://localhost/api/admin/navigation", {
    method: "PUT",
    body: JSON.stringify({ config }),
  });
}

async function freshOrgWithUser(): Promise<{ orgId: string; userId: string }> {
  const org = await createScratchOrg();
  const userId = await createScratchUser(org.orgId, "Nav Perm", "nav_perm_role");
  return { orgId: org.orgId, userId };
}

function asUser(orgId: string, userId: string, permissions: string[]): void {
  permState.authz = { user: { orgId, id: userId }, permissions: new Set(permissions), allowedSubsidiaryIds: null };
}

test("a holder of admin.nav.manage can save the nav config", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId, userId } = await freshOrgWithUser();
  try {
    asUser(orgId, userId, ["admin.nav.manage"]);
    const res = await PUT(putRequest(CONFIG));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const stored = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from org_nav_configs where org_id = ${orgId}`));
    assert.equal(stored.rows[0]!.count, 1);
  } finally {
    permState.authz = null;
    await dropScratchOrgReporting(orgId);
  }
});

test("a holder of admin.customization.manage keeps save access", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId, userId } = await freshOrgWithUser();
  try {
    asUser(orgId, userId, ["admin.customization.manage"]);
    const res = await PUT(putRequest(CONFIG));
    assert.equal(res.status, 200);
  } finally {
    permState.authz = null;
    await dropScratchOrgReporting(orgId);
  }
});

test("a user with neither admin key is refused without persisting anything", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId, userId } = await freshOrgWithUser();
  try {
    asUser(orgId, userId, ["reports.read"]);
    const res = await PUT(putRequest(CONFIG));
    assert.equal(res.status, 403);
    const stored = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from org_nav_configs where org_id = ${orgId}`));
    assert.equal(stored.rows[0]!.count, 0);
  } finally {
    permState.authz = null;
    await dropScratchOrgReporting(orgId);
  }
});

test("an unauthenticated save is refused", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId } = await freshOrgWithUser();
  try {
    permState.authz = null;
    const res = await PUT(putRequest(CONFIG));
    assert.equal(res.status, 401);
  } finally {
    await dropScratchOrgReporting(orgId);
  }
});
