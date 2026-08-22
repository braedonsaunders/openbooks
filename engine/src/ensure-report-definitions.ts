import { sql } from "drizzle-orm";
import {
  BUILT_IN_REPORT_DEFINITIONS,
  STANDARD_STATEMENT_DEFINITIONS,
  validateCustomQuery,
} from "@openbooks/reports";
import { db } from "./db.ts";

/**
 * Idempotently materialise the built-in + standard-statement report catalog as
 * `report_definitions` rows for one org. Keyed on `(org_id, slug)`; refreshes
 * name/description/spec while preserving row ids (and any schedules/runs FK'd to
 * them).
 *
 * ONLY rows this catalog still owns are refreshed. A slug collision is not
 * proof of ownership, and an unguarded upsert destroyed two kinds of real work:
 *
 *   - the PATCH API deliberately lets an org tune a seeded plan IN PLACE
 *     ("an org may tune a seeded plan") and leaves `kind = 'built_in'`, so the
 *     refresh silently reverted that edit with no audit row;
 *   - `uniqueReportSlug` only avoids collisions that exist AT CREATION TIME, so
 *     a catalog entry added later can land on an existing custom report's slug
 *     and overwrite a user-authored plan outright.
 *
 * Hence both guards. `kind = 'built_in'` keeps custom reports out; `updated_by
 * is null` keeps org-tuned ones out — this catalog is the only writer that
 * leaves `updated_by` NULL, so a non-null value means a person edited the row
 * and their edit outranks the seed. A definition that fails either guard is
 * left alone rather than captured: the catalog row simply does not materialise
 * under that slug, which is visible and recoverable, unlike silently
 * destroying the org's own work.
 *
 * The manual `seed-reports.ts` script seeds every org up front, but org
 * provisioning does not always run it — so slug→id resolution (e.g. the close
 * package delivery pipeline) calls this first to guarantee every catalog report
 * exists before rendering. A catalog typo fails loudly via validateCustomQuery.
 */
export async function ensureReportDefinitions(orgId: string): Promise<void> {
  for (const def of BUILT_IN_REPORT_DEFINITIONS) {
    const query = validateCustomQuery(def.query);
    await db.execute(sql`
      insert into report_definitions (org_id, kind, slug, name, description, query)
      values (${orgId}, 'built_in', ${def.slug}, ${def.name}, ${def.description}, ${JSON.stringify(query)}::jsonb)
      on conflict (org_id, slug) do update set
        name = excluded.name,
        description = excluded.description,
        query = excluded.query,
        updated_at = now()
      where report_definitions.kind = 'built_in' and report_definitions.updated_by is null
        and report_definitions.org_id = ${orgId}`);
  }
  for (const def of STANDARD_STATEMENT_DEFINITIONS) {
    const statement = { kind: def.statementKind, params: def.params ?? {} };
    await db.execute(sql`
      insert into report_definitions (org_id, kind, report_type, system, slug, name, description, query, statement)
      values (${orgId}, 'built_in', 'statement', true, ${def.slug}, ${def.name}, ${def.description}, null, ${JSON.stringify(statement)}::jsonb)
      on conflict (org_id, slug) do update set
        report_type = 'statement',
        system = true,
        name = excluded.name,
        description = excluded.description,
        query = null,
        statement = excluded.statement,
        updated_at = now()
      where report_definitions.kind = 'built_in' and report_definitions.updated_by is null
        and report_definitions.org_id = ${orgId}`);
  }
}
