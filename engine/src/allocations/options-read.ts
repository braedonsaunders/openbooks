import { sql } from "drizzle-orm";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { periodDisplayLabelSql } from "../periods/period-policy.ts";
import { db } from "../platform/db.ts";

export type AllocationOption = {
  id: string;
  label: string;
  extra?: string;
};

export type AllocationPartyOption = AllocationOption & {
  roles: string[];
};

export type AllocationSegmentOptions = {
  key: string;
  label: string;
  values: AllocationOption[];
};

export type AllocationOptions = {
  expenseAccounts: AllocationOption[];
  payComponents: AllocationOption[];
  accounts: (AllocationOption & { extra: string })[];
  departments: AllocationOption[];
  locations: AllocationOption[];
  classes: AllocationOption[];
  projects: AllocationOption[];
  subsidiaries: AllocationOption[];
  books: (AllocationOption & { extra: string })[];
  periods: (AllocationOption & { extra: string })[];
  rules: (AllocationOption & { extra: string })[];
  reports: (AllocationOption & { extra: string })[];
  flows: AllocationOption[];
  parties: AllocationPartyOption[];
  items: AllocationOption[];
  segments: AllocationSegmentOptions[];
};

export async function listAllocationOptions(input: {
  orgId: string;
  locale: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<AllocationOptions> {
  const { orgId, locale, allowedSubsidiaryIds } = input;
  const named = async (
    table: string,
    order: string,
    hasCode = true,
  ): Promise<AllocationOption[]> => {
    const label = hasCode
      ? sql`case when coalesce(code, '') <> '' then code || ' · ' || name else name end`
      : sql`name`;
    return db.execute<{ id: string; label: string }>(
      sql`
      select id::text as id, ${label} as label from ${sql.raw(table)}
       where org_id = ${orgId} and is_active
         ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
       order by ${sql.raw(order)}`,
      "objects",
    );
  };

  const [
    accounts,
    departments,
    locations,
    classes,
    projects,
    books,
    periods,
    rules,
    reports,
    flows,
  ] = await Promise.all([
    db.execute<{ id: string; label: string; extra: string }>(
      sql`
      select id::text as id, number || ' · ' || name as label, number as extra
        from accounts
       where org_id = ${orgId} and is_active and not is_summary
         ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
       order by number, name`,
      "objects",
    ),
    named("departments", "name"),
    named("locations", "name"),
    named("classes", "name"),
    named("projects", "name"),
    db.execute<{ id: string; label: string; extra: string }>(
      sql`
      select id::text as id, code || ' · ' || name as label, code as extra
        from accounting_books
       where org_id = ${orgId} and is_active and posts_gl
       order by is_primary desc, code`,
      "objects",
    ),
    db.execute<{ id: string; label: string; extra: string }>(
      sql`
      select p.id::text as id, ${periodDisplayLabelSql(locale, "p")} as label,
             p.starts_on::text || '…' || p.ends_on::text as extra
        from accounting_periods p
       where p.org_id = ${orgId}
       order by p.starts_on desc, p.is_adjustment, p.id limit 24`,
      "objects",
    ),
    db.execute<{ id: string; label: string; extra: string }>(
      sql`
      select id::text as id, name as label, key as extra
        from allocation_rules
       where org_id = ${orgId} and mode = 'period' and is_active
         and (${
           allowedSubsidiaryIds === null
             ? sql`true`
             : sql`exists (
           select 1 from allocation_rule_targets target
            where target.org_id = allocation_rules.org_id
              and target.version_id = allocation_rules.current_version_id
              ${subsidiaryVisibleFilter(sql`target.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
         )`
         })
       order by sort_order, name`,
      "objects",
    ),
    db.execute<{ id: string; label: string; extra: string }>(
      sql`
      select id::text as id, name as label, slug as extra
        from report_definitions
       where org_id = ${orgId} and archived_at is null
       order by name`,
      "objects",
    ),
    db.execute<{ id: string; label: string }>(
      sql`
      select id::text as id, name as label
        from flows
       where org_id = ${orgId} and enabled and subject_kind = 'allocation_run'
       order by name`,
      "objects",
    ),
  ]);

  const subsidiaries: AllocationOption[] =
    allowedSubsidiaryIds === null
      ? await named("subsidiaries", "name", false)
      : allowedSubsidiaryIds.size === 0
        ? []
        : await db.execute<{ id: string; label: string }>(
            sql`
          select id::text as id, name as label from subsidiaries
           where org_id = ${orgId} and is_active and id = any(${`{${[...allowedSubsidiaryIds].join(",")}}`}::uuid[])
           order by name`,
            "objects",
          );

  const emptyScope = allowedSubsidiaryIds !== null && allowedSubsidiaryIds.size === 0;
  const parties = emptyScope
    ? []
    : await db.execute<AllocationPartyOption>(
        sql`
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
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     group by p.id order by p.display_name limit 5000`,
        "objects",
      );
  const items = await db.execute<AllocationOption>(
    sql`
    select id::text as id, name as label, code as extra from items
     where org_id = ${orgId} and is_active order by name limit 5000`,
    "objects",
  );
  const segmentRows = emptyScope
    ? []
    : await db.execute<{
        key: string;
        id: string;
        label: string;
        extra: string | null;
      }>(
        sql`
    select sd.key as key, sv.id::text as id, sv.name as label, sv.code as extra
      from segment_values sv
      join segment_definitions sd on sd.id = sv.segment_id
     where sv.org_id = ${orgId} and sv.is_active
       and sd.org_id = ${orgId} and sd.is_active and sd.source_kind = 'custom'
       ${subsidiaryVisibleFilter(sql`sv.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     order by sd.sort_order, sd.name, sv.name limit 5000`,
        "objects",
      );
  const segmentDefs = emptyScope
    ? []
    : await db.execute<{ key: string; label: string }>(
        sql`
    select key, plural_name as label from segment_definitions
     where org_id = ${orgId} and is_active and source_kind = 'custom'
     order by sort_order, name`,
        "objects",
      );
  const segments = segmentDefs.map((def) => ({
    key: def.key,
    label: def.label,
    values: segmentRows
      .filter((row) => row.key === def.key)
      .map((row) => ({
        id: row.id,
        label: row.label,
        ...(row.extra === null ? {} : { extra: row.extra }),
      })),
  }));
  const expenseAccounts = await db.execute<AllocationOption>(
    sql`
    select id::text, number || ' · ' || name as label from accounts
     where org_id = ${orgId} and is_active and not is_summary and type in ('expense', 'cogs', 'expense_other')
       ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     order by number, name`,
    "objects",
  );
  const payComponents = await db.execute<AllocationOption>(
    sql`
    select id::text, code || ' · ' || name as label from pay_components
     where org_id = ${orgId} and is_active and kind in ('earning', 'employer_contribution')
     order by sequence, code`,
    "objects",
  );

  return {
    expenseAccounts,
    payComponents,
    accounts,
    departments,
    locations,
    classes,
    projects,
    subsidiaries,
    books,
    periods,
    rules,
    reports,
    flows,
    parties,
    items,
    segments,
  };
}
