import { randomBytes, scryptSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

/**
 * Create (or reset) an app user in one explicitly named production org:
 *   npx tsx engine/src/provisioning/seed-user.ts <org-id> <email> <name> [role] <password>
 *
 * The org is always an explicit argument, never inferred: picking "the
 * oldest production org" silently resets credentials in the wrong tenant
 * the moment a second production org exists. A password must be supplied
 * explicitly; credentials are never emitted.
 */

export type SeedUserInput = {
  orgId: string;
  email: string;
  name: string;
  role?: string;
  password: string;
};

export type SeedUserResult = {
  userId: string;
  orgId: string;
  orgName: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function seedUser(input: SeedUserInput): Promise<SeedUserResult> {
  const role = input.role ?? "admin";
  if (!input.password) {
    throw new Error("refusing to seed a user with an empty password: pass an explicit <password>");
  }
  const email = input.email?.trim().toLowerCase();
  if (!email) {
    throw new Error("refusing to seed a user with an empty email: pass an explicit <email>");
  }
  if (!input.name?.trim()) {
    throw new Error("refusing to seed a user with an empty name: pass an explicit <name>");
  }
  if (!UUID_RE.test(input.orgId ?? "")) {
    throw new Error(
      `unknown organization ${JSON.stringify(input.orgId)}: pass the production org id (uuid) as the first argument to seed-user.ts`,
    );
  }
  const org = (await db.execute<{ id: string; name: string; env_kind: string }>(sql`
    select id, name, env_kind from orgs where id = ${input.orgId}
  `));
  const target = org.rows[0];
  if (!target) {
    throw new Error(
      `no organization with id ${input.orgId}; create it before seeding a login user`,
    );
  }
  if (target.env_kind !== "production") {
    throw new Error(
      `refusing to seed a user into ${target.env_kind} organization ${target.name} (${target.id}); pass a production org id`,
    );
  }
  const salt = randomBytes(16);
  const hash = `${salt.toString("hex")}:${scryptSync(input.password, salt, 64).toString("hex")}`;
  const seeded = await db.transaction(async (tx) => {
    const roleRow = (await tx.execute<{ id: string }>(sql`
      select id from app_roles where org_id = ${target.id} and key = ${role} limit 1
    `));
    const roleId = roleRow.rows[0];
    if (!roleId) throw new Error(`role ${role} does not exist in organization ${target.name} (${target.id})`);
    const user = (await tx.execute<{ id: string }>(sql`
      insert into users (org_id, email, name, password_hash)
      values (${target.id}, ${email}, ${input.name}, ${hash})
      on conflict (org_id, email) do update
        set password_hash = ${hash}, is_active = true, updated_at = now()
      where users.org_id = ${target.id}
      returning id
    `));
    const userId = user.rows[0]!.id;
    await tx.execute(sql`
      -- The grant is the desired end state: re-seeding a user who already
      -- holds the role is a no-op, not a lost write.
      insert into role_assignments (org_id, user_id, role_id)
      values (${target.id}, ${userId}, ${roleId.id})
      on conflict (org_id, user_id, role_id) do nothing
    `);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${target.id}, 'users', ${userId}, 'seed_user',
              ${JSON.stringify({ email, name: input.name, role })}::jsonb, null)
    `);
    return { userId, orgId: target.id, orgName: target.name };
  });
  return seeded;
}

async function main(): Promise<void> {
  const [orgId, email, name, role = "admin", password] = process.argv.slice(2);
  if (!orgId || !email || !name || !password) {
    console.error("usage: seed-user.ts <org-id> <email> <name> [role] <password>");
    process.exit(1);
  }
  const seeded = await seedUser({ orgId, email, name, role, password });
  console.log(`user ${email} (${role}) ready in organization ${seeded.orgName} (${seeded.orgId})`);
}

/**
 * Run directly (`tsx seed-user.ts`) but never merely because this module was
 * bundled into another executable — see seed-project-types.ts.
 */
export function isSeedUserCli(entrypoint: string | undefined): boolean {
  return /(^|[/\\])seed-user\.(?:[cm]?[jt]s)$/.test(entrypoint ?? "");
}

if (isSeedUserCli(process.argv[1])) {
  void main().then(() => process.exit(0)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
