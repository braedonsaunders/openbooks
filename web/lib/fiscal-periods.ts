import { sql, type SQL } from 'drizzle-orm'

/**
 * Re-derive every non-adjustment period from its start date after the
 * organization fiscal-year start changes.
 *
 * The caller must run this inside the same transaction as the organization
 * setting update and temporarily remove the unique fiscal-period index so
 * intermediate row updates cannot collide.
 */
export function periodDerivationSql(orgId: string, startMonth: number): SQL {
  const janOffset = startMonth === 1 ? sql`0` : sql`1`
  return sql`
    update accounting_periods
       set period_number = ((extract(month from starts_on)::int - ${startMonth} + 12) % 12) + 1,
           fiscal_year = extract(year from starts_on)::int
             + case when extract(month from starts_on)::int >= ${startMonth} then ${janOffset} else 0 end,
           name = to_char(starts_on, 'Mon YYYY')
     where org_id = ${orgId} and not is_adjustment`
}
