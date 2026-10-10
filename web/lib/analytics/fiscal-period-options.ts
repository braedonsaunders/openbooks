import 'server-only'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import type { ExtraPeriodOption } from '../../app/(app)/reports/ReportFilterBar'

/**
 * Named fiscal periods for the analytics period picker, newest first.
 * Non-adjustment periods from the org's calendars — the same rows the
 * accounting-period presets resolve against — so an owner can open an
 * arbitrary closed month by name instead of hand-typing its dates.
 * Capped: a dropdown is a picker, not an archive.
 */
export async function analyticsFiscalPeriodOptions(orgId: string, limit = 25): Promise<ExtraPeriodOption[]> {
  const rows = (await db.execute<{ id: string; name: string; starts_on: string; ends_on: string }>(sql`
    select id, name, starts_on::text as starts_on, ends_on::text as ends_on
      from accounting_periods
     where org_id = ${orgId} and not is_adjustment
     order by starts_on desc
     limit ${limit}
  `)).rows
  return rows.map((row) => ({
    id: row.id,
    label: `${row.name} · ${row.starts_on} → ${row.ends_on}`,
    from: row.starts_on,
    to: row.ends_on,
  }))
}

/**
 * The analytics period picker's named fiscal periods plus their optgroup
 * label, resolved in the request locale. Selecting one compiles to
 * period=custom with its exact bounds, so the choice is URL-addressable
 * and every dashboard loader resolves the identical window.
 */
export async function analyticsFiscalPeriodPicker(orgId: string): Promise<{
  extraPeriods: ExtraPeriodOption[]
  extraPeriodsLabel: string
}> {
  const [t, extraPeriods] = await Promise.all([
    getTranslations('reports'),
    analyticsFiscalPeriodOptions(orgId),
  ])
  return { extraPeriods, extraPeriodsLabel: t('filterBar.fiscalPeriods') }
}
