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
 * them). Custom (user-authored) definitions are never touched.
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
        kind = 'built_in',
        name = excluded.name,
        description = excluded.description,
        query = excluded.query,
        updated_at = now()`);
  }
  for (const def of STANDARD_STATEMENT_DEFINITIONS) {
    const statement = { kind: def.statementKind, params: def.params ?? {} };
    await db.execute(sql`
      insert into report_definitions (org_id, kind, report_type, system, slug, name, description, query, statement)
      values (${orgId}, 'built_in', 'statement', true, ${def.slug}, ${def.name}, ${def.description}, null, ${JSON.stringify(statement)}::jsonb)
      on conflict (org_id, slug) do update set
        kind = 'built_in',
        report_type = 'statement',
        system = true,
        name = excluded.name,
        description = excluded.description,
        query = null,
        statement = excluded.statement,
        updated_at = now()`);
  }
}
