/**
 * Seed the built-in project types (Time & Materials, Fixed Price, Cost-Plus,
 * Not-to-Exceed, and Schedule of Values) for an organization. Idempotent:
 * existing types are preserved (tenant edits win) and only missing built-ins
 * are inserted.
 */
import { db } from "./db.ts";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { canonicalizeProjectFinancialProfile } from "./project-financial-profile-versions.ts";

export async function seedProjectTypes(
  orgId: string,
  actorId?: string | null,
): Promise<void> {
  for (const t of BUILTIN_PROJECT_TYPES) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into project_types (
          org_id, key, name, description, is_built_in, is_active, sort_order,
          billing_method, invoicing_profile, backup_profile,
          created_by, updated_by
        ) values (
          ${orgId}, ${t.key}, ${t.name}, ${t.description}, true, true, ${t.sortOrder},
          ${t.billingMethod}, ${JSON.stringify(t.invoicingProfile)}::jsonb,
          ${JSON.stringify(t.backupProfile)}::jsonb,
          ${actorId ?? null}, ${actorId ?? null}
        )
        on conflict (org_id, key) do nothing
      `);
      const row = (await tx.execute<{ id: string }>(sql`
        select id
          from project_types
         where org_id = ${orgId} and key = ${t.key}
         limit 1
      `));
      const type = row.rows[0]!;
      await tx.execute(sql`
        insert into project_financial_profile_versions (
          org_id, project_type_id, effective_from, financial_profile,
          reason, created_by, updated_by
        )
        select ${orgId}, ${type.id}, date '0001-01-01',
               ${JSON.stringify(canonicalizeProjectFinancialProfile(t.financialProfile))}::jsonb,
               'Initial built-in project financial policy',
               ${actorId ?? null}, ${actorId ?? null}
         where not exists (
           select 1
             from project_financial_profile_versions v
            where v.org_id = ${orgId}
              and v.project_type_id = ${type.id}
         )
      `);
    });
  }
}

async function main() {
  const org: any = await db.execute(
    sql`select id from orgs order by created_at`,
  );
  for (const row of org.rows) await seedProjectTypes(row.id);
  const c: any = await db.execute(
    sql`select count(*)::int n from project_types`,
  );
  const b: any = await db.execute(
    sql`select count(*)::int n from projects where project_type_id is not null`,
  );
  console.log("project_types:", c.rows[0].n, "| projects typed:", b.rows[0].n);
  process.exit(0);
}

/**
 * Run directly (`tsx seed-project-types.ts`) but never merely because this
 * module was bundled into another executable. In an esbuild bundle,
 * `import.meta.url` is the bundle URL for every inlined module, so comparing it
 * with argv[1] incorrectly launched this CLI from deployment bootstrap.mjs.
 */
export function isSeedProjectTypesCli(entrypoint: string | undefined): boolean {
  return /(^|[/\\])seed-project-types\.(?:[cm]?[jt]s)$/.test(entrypoint ?? "");
}

if (isSeedProjectTypesCli(process.argv[1])) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
