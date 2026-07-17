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
await db.execute(sql`
  insert into users (org_id, email, name, password_hash, role)
  values (${org.rows[0].id}, ${email.toLowerCase()}, ${name}, ${hash}, ${role})
  on conflict (org_id, email) do update set password_hash = ${hash}, role = ${role}, is_active = true
`);
console.log(`user ${email} (${role}) ready${supplied ? "" : ` — password: ${password}`}`);
process.exit(0);
