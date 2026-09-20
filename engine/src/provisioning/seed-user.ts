import { randomBytes, scryptSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

/**
 * Create (or reset) an app user:
 *   npx tsx engine/src/provisioning/seed-user.ts <email> <name> <role> <password>
 * A password must be supplied explicitly; credentials are never emitted.
 */

const [email, name, role = "admin", password] = process.argv.slice(2);
if (!email || !name || !password) {
  console.error("usage: seed-user.ts <email> <name> [role] <password>");
  process.exit(1);
}
const salt = randomBytes(16);
const hash = `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;

const org = (await db.execute<{ id: string }>(sql`
  select id from orgs
   where env_kind = 'production'
   order by created_at, id
   limit 1
`));
const orgRow = org.rows[0];
if (!orgRow) {
  throw new Error("no production organization exists; create one before seeding a login user");
}
const orgId = orgRow.id;
await db.transaction(async (tx) => {
  const roleRow = (await tx.execute<{ id: string }>(sql`
    select id from app_roles where org_id = ${orgId} and key = ${role} limit 1
  `));
  const roleId = roleRow.rows[0];
  if (!roleId) throw new Error(`role ${role} does not exist in the production organization`);
  const user = (await tx.execute<{ id: string }>(sql`
    insert into users (org_id, email, name, password_hash)
    values (${orgId}, ${email.toLowerCase()}, ${name}, ${hash})
    on conflict (org_id, email) do update
      set password_hash = ${hash}, is_active = true, updated_at = now()
    where users.org_id = ${orgId}
    returning id
  `));
  await tx.execute(sql`
    insert into role_assignments (org_id, user_id, role_id)
    values (${orgId}, ${user.rows[0]!.id}, ${roleId.id})
    on conflict (org_id, user_id, role_id) do nothing
  `);
});
console.log(`user ${email} (${role}) ready`);
process.exit(0);
