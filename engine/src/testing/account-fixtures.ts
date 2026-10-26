import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { assertFixtureDatabase } from "./fixture-database.ts";

/** Ordinary posting account used by payroll fixtures; custom dimensions and ownership remain explicit at call sites. */
export async function seedPostingAccount(
  orgId: string,
  number: string,
  name: string,
  type: string,
  subsidiaryId: string | null = null,
): Promise<string> {
  await assertFixtureDatabase();
  const id = randomUUID();
  await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
    reconcilable, required_dimensions, custom, subsidiary_id, subsidiary_include_children)
    values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false,
      '[]'::jsonb, '{}'::jsonb, ${subsidiaryId}, true)`);
  return id;
}
