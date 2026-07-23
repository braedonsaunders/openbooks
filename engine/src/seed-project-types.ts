/**
 * Seed the built-in project types (Time & Materials, Fixed Price, Cost-Plus,
 * Not-to-Exceed, and Schedule of Values) for an org and backfill existing projects' `project_type_id`
 * from their legacy `billing_method`. Idempotent: existing types are preserved
 * (tenant edits win) — only missing built-ins are inserted.
 */
import { db } from "./db.ts";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";

export async function seedProjectTypes(orgId: string, actorId?: string | null): Promise<void> {
  for (const t of BUILTIN_PROJECT_TYPES) {
    await db.execute(sql`
      insert into project_types (
        org_id, key, name, description, is_built_in, is_active, sort_order,
        billing_method, financial_profile, invoicing_profile, backup_profile,
        created_by, updated_by
      ) values (
        ${orgId}, ${t.key}, ${t.name}, ${t.description}, true, true, ${t.sortOrder},
        ${t.billingMethod}, ${JSON.stringify(t.financialProfile)}::jsonb,
        ${JSON.stringify(t.invoicingProfile)}::jsonb, ${JSON.stringify(t.backupProfile)}::jsonb,
        ${actorId ?? null}, ${actorId ?? null}
      )
      on conflict (org_id, key) do nothing
    `);
  }

  // Backfill projects: the built-in type key matches the billing_method enum
  // value (not_to_exceed is opt-in, so it never auto-assigns).
  await db.execute(sql`
    update projects p
       set project_type_id = pt.id, updated_at = now()
      from project_types pt
     where pt.org_id = p.org_id
       and pt.key = p.billing_method
       and p.org_id = ${orgId}
       and p.project_type_id is null
       and p.billing_method is not null
  `);
}

async function main() {
  const org: any = await db.execute(sql`select id from orgs order by created_at`);
  for (const row of org.rows) await seedProjectTypes(row.id);
  const c: any = await db.execute(sql`select count(*)::int n from project_types`);
  const b: any = await db.execute(sql`select count(*)::int n from projects where project_type_id is not null`);
  console.log("project_types:", c.rows[0].n, "| projects typed:", b.rows[0].n);
  process.exit(0);
}

// Run directly (tsx seed-project-types.ts) — but not when imported.
if (import.meta.url === `file://${process.argv[1]}`) main();
