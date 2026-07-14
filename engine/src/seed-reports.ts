import { sql } from "drizzle-orm";
import { BUILT_IN_REPORT_DEFINITIONS, validateCustomQuery } from "@openbooks/reports";
import { db } from "./db.ts";

/**
 * Seed the built-in report definitions:
 *   npx tsx engine/src/seed-reports.ts
 *
 * For every org, upsert one report_definitions row (kind = 'built_in') per
 * catalog entry in @openbooks/reports BUILT_IN_REPORT_DEFINITIONS:
 *   - AP aging by vendor
 *   - Open AR by customer
 *   - GL activity by account (this FY)
 *   - Expense detail by department (this FY)
 *
 * Each plan is re-validated through validateCustomQuery before storage, so a
 * catalog typo fails loudly here rather than at run time. Idempotent: keyed on
 * (org_id, slug), it refreshes name/description/query so re-running picks up
 * catalog changes while preserving the row id (and any schedules/runs FK'd to
 * it). Custom (user-authored) definitions are never touched.
 */

const orgs = (await db.execute(sql`select id, name from orgs order by created_at`)) as unknown as {
  rows: { id: string; name: string }[];
};
if (orgs.rows.length === 0) {
  console.error("no orgs found — seed an org before seeding built-in reports");
  process.exit(1);
}

for (const org of orgs.rows) {
  for (const def of BUILT_IN_REPORT_DEFINITIONS) {
    // Fail loudly if a catalog plan no longer matches the entity schema.
    const query = validateCustomQuery(def.query);
    await db.execute(sql`
      insert into report_definitions (org_id, kind, slug, name, description, query)
      values (${org.id}, 'built_in', ${def.slug}, ${def.name}, ${def.description}, ${JSON.stringify(query)}::jsonb)
      on conflict (org_id, slug) do update set
        kind = 'built_in',
        name = excluded.name,
        description = excluded.description,
        query = excluded.query,
        updated_at = now()
    `);
    console.log(`org "${org.name}": built-in report "${def.name}" ready`);
  }
}
process.exit(0);
