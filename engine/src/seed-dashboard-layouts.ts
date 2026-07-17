import { sql } from "drizzle-orm";
import { DASHBOARD_ROLE_KEYS } from "@openbooks/schema";
import { db } from "./db.ts";
import { seedDashboardDefaultsForOrg } from "./dashboard-defaults.ts";

/**
 * Seed role-specific home dashboards for every tenant:
 *   npx tsx engine/src/seed-dashboard-layouts.ts
 *
 * Idempotent. Product-owned built-in defaults are refreshed; custom roles get
 * the read-focused viewer layout. Personal user layouts are never changed.
 */

const orgs = (await db.execute(sql`
  select o.id, o.name,
         coalesce(array_agg(r.key order by r.key) filter (where r.key is not null), '{}') as role_keys
    from orgs o
    left join app_roles r on r.org_id = o.id
   group by o.id, o.name
   order by o.created_at
`)) as unknown as { rows: Array<{ id: string; name: string; role_keys: string[] }> };

if (orgs.rows.length === 0) {
  console.error("no orgs found — seed an org before seeding dashboard layouts");
  process.exit(1);
}

for (const org of orgs.rows) {
  const roleKeys = [...new Set([...DASHBOARD_ROLE_KEYS, ...org.role_keys])];
  const count = await seedDashboardDefaultsForOrg(org.id, roleKeys);
  console.log(`org "${org.name}": ${count} role dashboard default(s) upserted`);
}

process.exit(0);
