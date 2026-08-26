import { sql, type SQL } from "drizzle-orm";

/**
 * Move the eligible calendar's current period numbers out of the canonical
 * range before re-derivation. This avoids transient unique-key collisions when
 * two periods exchange fiscal labels, without dropping a tenant-shared index.
 *
 * Both this staging update and periodDerivationSql independently require a
 * fresh active default calendar. The route still performs the same eligibility
 * check before changing any organization state so a guarded no-op can never be
 * mistaken for success.
 */
export function periodDerivationStagingSql(orgId: string): SQL {
  return sql`
    update accounting_periods as target
       set period_number = -period_number
     where target.org_id = ${orgId}
       and not target.is_adjustment
       and target.fiscal_calendar_id = (
         select calendar.id
           from fiscal_calendars calendar
          where calendar.org_id = ${orgId}
            and calendar.is_default
            and calendar.is_active
       )
       and not exists (
         select 1
           from accounting_periods history_period
           join journal_entries entry
             on entry.org_id = history_period.org_id
            and entry.period_id = history_period.id
          where history_period.org_id = target.org_id
            and history_period.fiscal_calendar_id = target.fiscal_calendar_id
            and entry.status in ('posted', 'reversed')
       )
       and not exists (
         select 1
           from accounting_periods history_period
           join period_locks period_lock
             on period_lock.org_id = history_period.org_id
            and period_lock.period_id = history_period.id
          where history_period.org_id = target.org_id
            and history_period.fiscal_calendar_id = target.fiscal_calendar_id
            and (
              period_lock.state <> 'open'
              or period_lock.reopen_expires_at <= now()
            )
       )`;
}

/**
 * Re-derive the active default calendar's non-adjustment periods from their
 * start dates after the organization fiscal-year start changes.
 *
 * Posted/reversed journals and non-open (or expired-reopen) period locks make
 * the entire calendar ineligible, so this statement never partially relabels
 * accounting history even if a caller omits the route-level activity check.
 */
export function periodDerivationSql(orgId: string, startMonth: number): SQL {
  const janOffset = startMonth === 1 ? sql`0` : sql`1`;
  return sql`
    update accounting_periods as target
       set period_number = ((extract(month from starts_on)::int - ${startMonth} + 12) % 12) + 1,
           fiscal_year = extract(year from starts_on)::int
             + case when extract(month from starts_on)::int >= ${startMonth} then ${janOffset} else 0 end,
           name = to_char(starts_on, 'Mon YYYY')
     where target.org_id = ${orgId}
       and not target.is_adjustment
       and target.fiscal_calendar_id = (
         select calendar.id
           from fiscal_calendars calendar
          where calendar.org_id = ${orgId}
            and calendar.is_default
            and calendar.is_active
       )
       and not exists (
         select 1
           from accounting_periods history_period
           join journal_entries entry
             on entry.org_id = history_period.org_id
            and entry.period_id = history_period.id
          where history_period.org_id = target.org_id
            and history_period.fiscal_calendar_id = target.fiscal_calendar_id
            and entry.status in ('posted', 'reversed')
       )
       and not exists (
         select 1
           from accounting_periods history_period
           join period_locks period_lock
             on period_lock.org_id = history_period.org_id
            and period_lock.period_id = history_period.id
          where history_period.org_id = target.org_id
            and history_period.fiscal_calendar_id = target.fiscal_calendar_id
            and (
              period_lock.state <> 'open'
              or period_lock.reopen_expires_at <= now()
            )
       )`;
}
