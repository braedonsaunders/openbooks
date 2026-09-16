import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { guardAllocations } from "../../../../lib/allocations-gate";
import { db } from "../../../../../engine/src/db.ts";
import { NATIVE_MEASURES } from "../../../../../engine/src/allocations/driver-admin.ts";

export const runtime = "nodejs";

interface Option {
  id: string;
  label: string;
  extra?: string;
}

/**
 * One picker payload for the Drivers + Runs tabs (A8): postable accounts,
 * active dimension values, recent periods, posting books, period-mode rules
 * and report definitions. `allocations.read`. The Rules tab (A7) owns the
 * rule definitions; this only lists them for run filters and previews.
 */
export async function GET() {
  const gate = await guardAllocations("allocations.read");
  if (gate instanceof NextResponse) return gate;
  const orgId = gate.user.orgId;

  const named = async (table: string, order: string): Promise<Option[]> => {
    const rows = await db.execute<{ id: string; label: string }>(sql`
      select id::text as id, name as label from ${sql.raw(table)}
       where org_id = ${orgId} and is_active order by ${sql.raw(order)}`);
    return rows.rows;
  };

  const [accounts, departments, locations, classes, projects, books, periods, rules, reports] = await Promise.all([
    db.execute<{ id: string; label: string; extra: string }>(sql`
      select id::text as id, number || ' · ' || name as label, number as extra
        from accounts
       where org_id = ${orgId} and is_active and not is_summary
       order by number, name`),
    named("departments", "name"),
    named("locations", "name"),
    named("classes", "name"),
    named("projects", "name"),
    db.execute<{ id: string; label: string; extra: string }>(sql`
      select id::text as id, code || ' · ' || name as label, code as extra
        from accounting_books
       where org_id = ${orgId} and is_active and posts_gl
       order by is_primary desc, code`),
    db.execute<{ id: string; label: string; extra: string }>(sql`
      select id::text as id, name as label,
             starts_on::text || '…' || ends_on::text as extra
        from accounting_periods
       where org_id = ${orgId}
       order by starts_on desc limit 24`),
    db.execute<{ id: string; label: string; extra: string }>(sql`
      select id::text as id, name as label, key as extra
        from allocation_rules
       where org_id = ${orgId} and mode = 'period' and is_active
       order by sort_order, name`),
    db.execute<{ id: string; label: string; extra: string }>(sql`
      select id::text as id, name as label, slug as extra
        from report_definitions
       where org_id = ${orgId}
       order by name`),
  ]);

  let subsidiaries: Option[];
  if (gate.allowedSubsidiaryIds === null) {
    subsidiaries = await named("subsidiaries", "name");
  } else {
    const ids = [...gate.allowedSubsidiaryIds];
    subsidiaries = ids.length === 0 ? [] : (
      await db.execute<{ id: string; label: string }>(sql`
        select id::text as id, name as label from subsidiaries
         where org_id = ${orgId} and is_active and id = any(${`{${ids.join(",")}}`}::uuid[])
         order by name`)
    ).rows;
  }

  return NextResponse.json({
    accounts: accounts.rows,
    departments,
    locations,
    classes,
    projects,
    subsidiaries,
    books: books.rows,
    periods: periods.rows,
    rules: rules.rows,
    reports: reports.rows,
    measures: NATIVE_MEASURES.map((measure) => ({ id: measure, label: measure })),
  });
}
