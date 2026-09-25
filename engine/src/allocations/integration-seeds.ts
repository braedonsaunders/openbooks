import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

/**
 * Shared seed fixtures for the allocations integration suites (DB-owned).
 *
 * These builders were copy-pasted across the suites byte-for-byte (six
 * `seedDepartment`, five `enableAllocations`, two `negate`); they live here
 * once so a seed-SQL change touches one site. Pure seed SQL and string math
 * only — no assertions, so no behavioural cover moves.
 */
export async function seedDepartment(orgId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into departments (id, org_id, name, is_active, custom)
    values (${id}, ${orgId}, ${name}, true, '{}'::jsonb)`);
  return id;
}

export async function enableAllocations(orgId: string, on = true): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(
      settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ allocations: on })}::jsonb, true)
    where id = ${orgId}
  `);
}

export function negate(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : `-${amount}`;
}
