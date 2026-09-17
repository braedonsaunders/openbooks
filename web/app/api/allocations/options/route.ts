import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { guardAllocations } from "../../../../lib/allocations-gate";
import { subsidiaryVisibleFilter } from "../../../../lib/subsidiaries";
import { db } from "../../../../../engine/src/db.ts";
import { NATIVE_MEASURES } from "../../../../../engine/src/allocations/driver-admin.ts";

export const runtime = "nodejs";

type Option = {
  id: string;
  label: string;
  extra?: string;
};

type PartyOption = Option & {
  /** Active canonical roles (vendor/customer/employee); empty = none. */
  roles: string[];
};

type SegmentOptions = {
  key: string;
  label: string;
  values: Option[];
};

/**
 * One picker payload for the Drivers + Runs tabs (A8): postable accounts,
 * active dimension values, recent periods, posting books, period-mode rules,
 * report definitions, approval flows for the allocation_run subject (A14),
 * parties (with canonical roles), items, and custom
 * segment values. `allocations.read`. The Rules tab (A7) owns the rule
 * definitions; this only lists them for run filters and previews. Parties
 * and segment values follow the same subsidiary scope as the other
 * subsidiary-aware kinds (null-subsidiary rows are org-wide; an empty scope
 * discloses none); items are organization-wide.
 */
export async function GET() {
  const gate = await guardAllocations("allocations.read");
  if (gate instanceof NextResponse) return gate;
  const orgId = gate.user.orgId;

  const named = async (table: string, order: string, hasCode = true): Promise<Option[]> => {
    const label = hasCode
      ? sql`case when coalesce(code, '') <> '' then code || ' · ' || name else name end`
      : sql`name`;
    const rows = await db.execute<{ id: string; label: string }>(sql`
      select id::text as id, ${label} as label from ${sql.raw(table)}
       where org_id = ${orgId} and is_active order by ${sql.raw(order)}`);
    return rows.rows;
  };

  const [accounts, departments, locations, classes, projects, books, periods, rules, reports, flows] = await Promise.all([
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
    // Approval-flow picker (A14): only enabled flows authored over the
    // allocation_run subject can gate a run — every other kind would fail
    // closed at post time, so the picker never offers them.
    db.execute<{ id: string; label: string }>(sql`
      select id::text as id, name as label
        from flows
       where org_id = ${orgId} and enabled and subject_kind = 'allocation_run'
       order by name`),
  ]);

  let subsidiaries: Option[];
  if (gate.allowedSubsidiaryIds === null) {
    subsidiaries = await named("subsidiaries", "name", false);
  } else {
    const ids = [...gate.allowedSubsidiaryIds];
    subsidiaries = ids.length === 0 ? [] : (
      await db.execute<{ id: string; label: string }>(sql`
        select id::text as id, name as label from subsidiaries
         where org_id = ${orgId} and is_active and id = any(${`{${ids.join(",")}}`}::uuid[])
         order by name`)
    ).rows;
  }

  // An empty entity scope discloses none of the subsidiary-aware records,
  // exactly like the subsidiaries list above (the shared forms pickers
  // early-return the same way).
  const scopedIds = gate.allowedSubsidiaryIds === null ? null : [...gate.allowedSubsidiaryIds];
  const emptyScope = scopedIds !== null && scopedIds.length === 0;

  // Role membership comes exclusively from the canonical role tables.
  const parties = emptyScope ? [] : (await db.execute<PartyOption>(sql`
    select p.id::text as id, p.display_name as label, p.short_code as extra,
           coalesce(array_remove(array_agg(distinct r.role), null), '{}') as roles
      from parties p
      left join (
        select party_id, 'vendor' as role from vendor_roles where org_id = ${orgId} and is_active
        union all
        select party_id, 'customer' as role from customer_roles where org_id = ${orgId} and is_active
        union all
        select party_id, 'employee' as role from employee_roles where org_id = ${orgId} and is_active
      ) r on r.party_id = p.id
     where p.org_id = ${orgId} and p.is_active
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
     group by p.id order by p.display_name limit 5000`)).rows;

  const items = (await db.execute<Option>(sql`
    select id::text as id, name as label, code as extra from items
     where org_id = ${orgId} and is_active order by name limit 5000`)).rows;

  const segmentRows = emptyScope ? [] : (await db.execute<{ key: string; id: string; label: string; extra: string | null }>(sql`
    select sd.key as key, sv.id::text as id, sv.name as label, sv.code as extra
      from segment_values sv
      join segment_definitions sd on sd.id = sv.segment_id
     where sv.org_id = ${orgId} and sv.is_active
       and sd.org_id = ${orgId} and sd.is_active and sd.source_kind = 'custom'
       ${subsidiaryVisibleFilter(sql`sv.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
     order by sd.sort_order, sd.name, sv.name limit 5000`)).rows;
  const segmentDefs = emptyScope ? [] : (await db.execute<{ key: string; label: string }>(sql`
    select key, plural_name as label from segment_definitions
     where org_id = ${orgId} and is_active and source_kind = 'custom'
     order by sort_order, name`)).rows;
  const segments: SegmentOptions[] = segmentDefs.map((def) => ({
    key: def.key,
    label: def.label,
    values: segmentRows
      .filter((row) => row.key === def.key)
      .map((row) => ({ id: row.id, label: row.label, ...(row.extra === null ? {} : { extra: row.extra }) })),
  }));

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
    flows: flows.rows,
    measures: NATIVE_MEASURES.map((measure) => ({ id: measure, label: measure })),
    parties,
    items,
    segments,
  });
}
