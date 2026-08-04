import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { BUILT_IN_ROLES } from "../../web/lib/permissions.ts";
import { seedDashboardDefaultsForOrg } from "./dashboard-defaults.ts";

/**
 * Seed the RBAC foundation:
 *   npx tsx engine/src/seed-roles.ts
 *
 * For every org: upsert the built-in roles into app_roles.
 *
 * Idempotent — built-in role definitions are refreshed on re-run (name,
 * description, permissions), existing assignments are left untouched, and
 * custom roles are never modified.
 */

const orgs = (await db.execute(sql`select id, name from orgs order by created_at`)) as any;
if (orgs.rows.length === 0) {
  console.error("no orgs found — seed an org before seeding roles");
  process.exit(1);
}

for (const org of orgs.rows) {
  for (const [key, def] of Object.entries(BUILT_IN_ROLES)) {
    await db.execute(sql`
      insert into app_roles (org_id, key, name, description, is_built_in, permissions)
      values (${org.id}, ${key}, ${def.name}, ${def.description}, true,
              ${JSON.stringify(def.permissions)})
      on conflict (org_id, key) do update
        set name = excluded.name,
            description = excluded.description,
            is_built_in = true,
            permissions = excluded.permissions,
            updated_at = now()
    `);
  }

  const dashboardCount = await seedDashboardDefaultsForOrg(
    org.id,
    Object.keys(BUILT_IN_ROLES),
  );

  console.log(
    `org "${org.name}": ${Object.keys(BUILT_IN_ROLES).length} built-in roles upserted, ` +
      `${dashboardCount} dashboard default(s) upserted`,
  );
}
process.exit(0);
