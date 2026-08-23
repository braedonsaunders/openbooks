import { randomBytes, scryptSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";

/**
 * Create (or reset) an app user:
 *   npx tsx engine/src/seed-user.ts <email> <name> <role> [password]
 * Prints a generated password when none is supplied.
 */

const [email, name, role = "admin", supplied] = process.argv.slice(2);
if (!email || !name) {
  console.error("usage: seed-user.ts <email> <name> [role] [password]");
  process.exit(1);
}
const password = supplied ?? randomBytes(9).toString("base64url");
const salt = randomBytes(16);
const hash = `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;

const org = (await db.execute(sql`
  select id from orgs
   where env_kind = 'production'
   order by created_at, id
   limit 1
`)) as any;
if (!org.rows[0]) {
  throw new Error("no production organization exists; create one before seeding a login user");
}
await db.transaction(async (tx) => {
  const roleRow = (await tx.execute<{ id: string }>(sql`
    select id from app_roles where org_id = ${org.rows[0].id} and key = ${role} limit 1
  `));
  if (!roleRow.rows[0]) throw new Error(`role ${role} does not exist in the production organization`);
  const user = (await tx.execute<{ id: string }>(sql`
    insert into users (org_id, email, name, password_hash)
    values (${org.rows[0].id}, ${email.toLowerCase()}, ${name}, ${hash})
    on conflict (org_id, email) do update
      set password_hash = ${hash}, is_active = true, updated_at = now()
    where users.org_id = ${org.rows[0].id}
    returning id
  `));
  await tx.execute(sql`
    insert into role_assignments (org_id, user_id, role_id)
    values (${org.rows[0].id}, ${user.rows[0]!.id}, ${roleRow.rows[0].id})
    on conflict (org_id, user_id, role_id) do nothing
  `);
});
console.log(`user ${email} (${role}) ready${supplied ? "" : ` — password: ${password}`}`);
process.exit(0);
