import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// F-t01-012 — the column is labeled "Last sign-in", so sort=last_sign_in
// must order by recency with nulls last in both directions. The whitelist
// only knew last_login, so the finding's URL silently fell back to name
// ordering (the two observed orders are exact reverses of each other)
// which reads as nulls interleaved around sorted dates.
const stateKey = Symbol.for("openbooks.admin-users-sort-test");
const state: { authz: unknown } = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.admin-users-sort-test')]
  export async function requirePermission() { return state.authz }
  export function can(authz, permission) { return authz.permissions.has(permission) }
`;
const mockIntl = `
  export async function getTranslations() { return (key) => key }
  export async function getLocale() { return 'en' }
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("/admin/users/")) {
      return { url: "mock:admin-users-sort-authz", shortCircuit: true };
    }
    if (specifier === "next-intl/server") {
      return { url: "mock:admin-users-sort-intl", shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const webRoot = import.meta.url.slice(0, import.meta.url.indexOf("/web/") + 5);
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context);
    }
    // Worktree node_modules symlinks to the main checkout's install: pin
    // bare self-imports to this checkout (same modules a real install
    // resolves) so the loader and its transitive engine imports agree.
    if (specifier.startsWith("@openbooks/engine/")) {
      const root = import.meta.url.slice(0, import.meta.url.indexOf("/web/") + 1);
      return nextResolve(
        new URL(`engine/${specifier.slice("@openbooks/engine/".length)}`, root).href,
        context,
      );
    }
    if (context.parentURL?.startsWith("mock:")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:admin-users-sort-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:admin-users-sort-intl") {
      return { format: "module", source: mockIntl, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { loadAdminUsers } = await import("./view.ts");
type Authz = import("@/lib/authz.ts").Authz;

const DB = !!process.env.OPENBOOKS_DB_URL;

function authzFor(orgId: string, userId: string): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "Sort Admin", orgId,
      roles: [{ key: "admin", name: "admin" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(["admin.users.manage"]),
    allowedSubsidiaryIds: null,
  };
}

for (const dir of ["desc", "asc"] as const) {
  test(`users sort=last_sign_in orders by recency with nulls last (${dir})`, { skip: !DB }, async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      // Names deliberately anti-correlate with recency so a silent fallback
      // to name ordering cannot pass: name-asc would read Amy, Mid, Zed.
      const amy = (await withBypass(() => createScratchUser(org.orgId, "Amy", "viewer"))) as unknown as string;
      const mid = (await withBypass(() => createScratchUser(org.orgId, "Mid", "viewer"))) as unknown as string;
      const zed = (await withBypass(() => createScratchUser(org.orgId, "Zed", "viewer"))) as unknown as string;
      await withBypass(async () => {
        await db.execute(sql`update users set last_login_at = '2026-01-01T00:00:00Z' where id = ${amy}`);
        await db.execute(sql`update users set last_login_at = '2026-06-01T00:00:00Z' where id = ${zed}`);
      });
      const admin = (await withBypass(() => createScratchUser(org.orgId, "Sort Admin", "admin"))) as unknown as string;
      state.authz = authzFor(org.orgId, admin);
      const data = await withOrgContext(org.orgId, () =>
        loadAdminUsers({ sort: "last_sign_in", dir }),
      );
      const dated = data.users.filter((u) => u.lastSignIn !== "—").map((u) => u.name);
      const tailed = data.users.slice(-1)[0]!;
      assert.deepEqual(dated, dir === "desc" ? ["Zed", "Amy"] : ["Amy", "Zed"]);
      assert.equal(tailed.lastSignIn, "—", "never-signed-in rows sort last in both directions");
      assert.ok(tailed.id === mid || tailed.id === admin);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  });
}
