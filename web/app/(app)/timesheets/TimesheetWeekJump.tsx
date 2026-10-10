'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

/** Snap an ISO date to its Sunday, the org's week start. */
function sundayOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, m! - 1, d!, 12))
  dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay())
  return dt.toISOString().slice(0, 10)
}

/**
 * Jump straight to any week for the New-timesheet employee, preserving the
 * shareable drawer id (?timesheet=<employee>:<weekStart>). A picked date
 * snaps to its Sunday; partial typing navigates nowhere. Writes keep their
 * existing locked-period refusals — navigation itself is read-only.
 */
export function TimesheetWeekJump({ basePath, employeeId }: { basePath: string; employeeId: string }) {
  const t = useTranslations('timesheets')
  const router = useRouter()
  return (
    <input
      type="date"
      defaultValue=""
      onChange={(e) => {
        if (e.target.value) router.push(`${basePath}?timesheet=${employeeId}:${sundayOf(e.target.value)}` as never)
      }}
      className="h-8 shrink-0 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-950"
      aria-label={t('grid.weekJump')}
      title={t('grid.weekJump')}
    />
  )
}
