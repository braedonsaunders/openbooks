import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression: saving a nav config whose payload references
// MULTIPLE installed apps must round-trip. The save path validates the app
// keys with `= any(<collection>::text[])`; a plain JS array bound into a
// drizzle sql template serializes as a row constructor `( $1, $2 )`, which
// PostgreSQL rejects ("cannot cast type record to text[]") once it holds more
// than one element — a single app item can mask the bug, so every save here
// that carries apps is deliberately multi-app.
const stateKey = Symbol.for("openbooks.nav-route-test");
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
  const state = globalThis[Symbol.for('openbooks.nav-route-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as platform.test.ts).
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // Forward Next.js-style aliases to the real modules they point at.
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("admin/navigation")) {
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

const routeUrl = "./route.ts?nav-array-binding-test";
const { PUT } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);

interface NavConfigLike {
  version: number;
  groups: { id: string; label: string; items: Record<string, unknown>[] }[];
}

async function seedInstalledApps(orgId: string, keys: string[]): Promise<void> {
  for (const key of keys) {
    await db.execute(sql`
      insert into apps (org_id, key, name)
      values (${orgId}, ${key}, ${key.replaceAll("-", " ")})`);
  }
}

function putRequest(config: unknown): Request {
  return new Request("http://localhost/api/admin/navigation", {
    method: "PUT",
    body: JSON.stringify({ config }),
  });
}

test("saving a nav config with multiple app items round-trips and audits against live PG", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const adminId = await createScratchUser(org.orgId, "Nav Admin", "admin");
  try {
    routeState.authz = {
      user: { orgId: org.orgId, id: adminId },
      permissions: new Set(["admin.customization.manage"]),
      allowedSubsidiaryIds: null,
    };

    const config: NavConfigLike = {
      version: 2,
      groups: [
        {
          id: "workspace",
          label: "Workspace",
          items: [
            { kind: "module", moduleKey: "dashboard" },
            { kind: "app", appKey: "ledger-sync", label: "Ledger Sync" },
            { kind: "app", appKey: "field-ops" },
            { kind: "link", href: "/reports", label: "Reports" },
          ],
        },
      ],
    };
    await seedInstalledApps(org.orgId, ["ledger-sync", "field-ops"]);

    const res = await PUT(putRequest(config));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const stored = (await db.execute<{ config: NavConfigLike }>(sql`
      select config from org_nav_configs where org_id = ${org.orgId}`));
    assert.equal(stored.rows.length, 1);
    assert.deepEqual(stored.rows[0]!.config, config);

    const audits = (await db.execute<{ action: string }>(sql`
      select action from audit_log
       where org_id = ${org.orgId} and table_name = 'org_nav_configs'
       order by at`));
    assert.deepEqual(audits.rows.map((r) => r.action), ["insert"]);

    // A second save updates in place and audits the update lifecycle.
    const revised: NavConfigLike = {
      ...config,
      groups: [{ ...config.groups[0]!, items: [...config.groups[0]!.items] }],
    };
    revised.groups[0]!.label = "Operations Workspace";
    const res2 = await PUT(putRequest(revised));
    assert.equal(res2.status, 200);
    const stored2 = (await db.execute<{ config: NavConfigLike }>(sql`
      select config from org_nav_configs where org_id = ${org.orgId}`));
    assert.deepEqual(stored2.rows[0]!.config, revised);
    const audits2 = (await db.execute<{ action: string }>(sql`
      select action from audit_log
       where org_id = ${org.orgId} and table_name = 'org_nav_configs'
       order by at`));
    assert.deepEqual(audits2.rows.map((r) => r.action), ["insert", "update"]);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReportingSafe(org.orgId);
  }
});

test("a nav config referencing an uninstalled app is refused without persisting anything", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const adminId = await createScratchUser(org.orgId, "Nav Admin", "admin");
  try {
    routeState.authz = {
      user: { orgId: org.orgId, id: adminId },
      permissions: new Set(["admin.customization.manage"]),
      allowedSubsidiaryIds: null,
    };
    await seedInstalledApps(org.orgId, ["ledger-sync", "field-ops"]);

    const config: NavConfigLike = {
      version: 2,
      groups: [
        {
          id: "workspace",
          label: "Workspace",
          items: [
            { kind: "app", appKey: "ledger-sync" },
            { kind: "app", appKey: "field-ops" },
            { kind: "app", appKey: "ghost-app" },
          ],
        },
      ],
    };
    const res = await PUT(putRequest(config));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "navigation references an unknown app" });

    const stored = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from org_nav_configs where org_id = ${org.orgId}`));
    assert.equal(stored.rows[0]!.count, 0);
    const audits = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from audit_log
       where org_id = ${org.orgId} and table_name = 'org_nav_configs'`));
    assert.equal(audits.rows[0]!.count, 0);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReportingSafe(org.orgId);
  }
});

test("a module-only nav config skips the app catalog check and still round-trips", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const adminId = await createScratchUser(org.orgId, "Nav Admin", "admin");
  try {
    routeState.authz = {
      user: { orgId: org.orgId, id: adminId },
      permissions: new Set(["admin.customization.manage"]),
      allowedSubsidiaryIds: null,
    };

    const config: NavConfigLike = {
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
    const res = await PUT(putRequest(config));
    assert.equal(res.status, 200);
    const stored = (await db.execute<{ config: NavConfigLike }>(sql`
      select config from org_nav_configs where org_id = ${org.orgId}`));
    assert.deepEqual(stored.rows[0]!.config, config);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReportingSafe(org.orgId);
  }
});

/** Teardown failures must not replace an in-flight assertion error. */
async function dropScratchOrgReportingSafe(orgId: string): Promise<void> {
  const { dropScratchOrgReporting } = await import("@openbooks/engine/src/test-fixtures.ts");
  await dropScratchOrgReporting(orgId);
}
