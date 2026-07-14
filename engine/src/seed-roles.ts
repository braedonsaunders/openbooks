import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { BUILT_IN_ROLES } from "../../web/lib/permissions.ts";

/**
 * Seed the RBAC foundation:
 *   npx tsx engine/src/seed-roles.ts
 *
 * For every org: upsert the built-in roles into app_roles, then create a
 * role_assignments row for each existing user pointing at the built-in role
 * whose key equals their legacy users.role value.
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

  const assigned = (await db.execute(sql`
    insert into role_assignments (org_id, user_id, role_id)
    select u.org_id, u.id, r.id
      from users u
      join app_roles r on r.org_id = u.org_id and r.key = u.role
     where u.org_id = ${org.id}
    on conflict (org_id, user_id, role_id) do nothing
  `)) as any;

  console.log(
    `org "${org.name}": ${Object.keys(BUILT_IN_ROLES).length} built-in roles upserted, ` +
      `${assigned.rowCount ?? 0} role assignment(s) created from users.role`,
  );
}
process.exit(0);
