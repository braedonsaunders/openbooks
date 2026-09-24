import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The sidebar resolver is a server module (server-only marker); shim the
// marker so it loads under the plain runner, then import the unit under test.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});
const { resolveNav } = await import("./resolve.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Feature gating compares the link's module pathname, not its decorations.
 * An admin-saved /projects?tab=jobs link enters the Projects module exactly
 * like /projects, so with Projects disabled it must hide (it used to stay
 * visible because the query suffix missed the href comparison), and with
 * Projects enabled it shows again. Same for #fragments.
 */
test(
  "custom links with a query or fragment follow their module's feature gate",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await createScratchOrg();
    try {
      const userId = await createScratchUser(org.orgId, "Nav Admin", "admin");
      const config = {
        version: 2,
        groups: [
          {
            id: "ops",
            label: "Ops",
            items: [
              { kind: "link", href: "/projects?tab=jobs", label: "Jobs" },
              { kind: "link", href: "/projects#summary", label: "Summary" },
            ],
          },
        ],
      };
      await db.execute(sql`
        insert into org_nav_configs (org_id, config, created_by, updated_by)
        values (${org.orgId}, ${JSON.stringify(config)}::jsonb, ${userId}, ${userId})`);
      const t = (key: string): string => key;
      const can = (): boolean => true;
      const hrefs = (groups: { items: { href: string }[] }[]): string[] =>
        groups.flatMap((group) => group.items.map((item) => item.href));

      async function setProjectsEnabled(enabled: boolean): Promise<void> {
        const row = (await db.execute<{ settings: unknown }>(sql`
          select settings from orgs where id = ${org.orgId}`)).rows[0];
        const current = (row?.settings ?? {}) as Record<string, unknown>;
        const features = { ...((current.features ?? {}) as Record<string, unknown>), projects: enabled };
        await db.execute(sql`
          update orgs set settings = ${JSON.stringify({ ...current, features })}::jsonb
           where id = ${org.orgId}`);
      }

      await setProjectsEnabled(false);
      const gated = hrefs(await resolveNav(org.orgId, can, [], t));
      assert.ok(!gated.includes("/projects?tab=jobs"), "query link into a disabled module hides");
      assert.ok(!gated.includes("/projects#summary"), "fragment link into a disabled module hides");

      await setProjectsEnabled(true);
      const open = hrefs(await resolveNav(org.orgId, can, [], t));
      assert.ok(open.includes("/projects?tab=jobs"), "query link into an enabled module shows");
      assert.ok(open.includes("/projects#summary"), "fragment link into an enabled module shows");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
