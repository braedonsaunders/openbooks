'use client'

import { useTranslations } from 'next-intl'

export interface CrewTodayRow {
  employeePartyId: string
  employeeName: string | null
  since: string
  costCodeRef: string | null
  geoCheck: string
}

/** Project cockpit "Crew today": who is clocked in, and where-flagged. */
export function CrewTodaySection({ rows }: { rows: CrewTodayRow[] }) {
  const t = useTranslations('projects')
  if (rows.length === 0) return null
  return (
    <section className="space-y-2" aria-label={t('cockpit.crewToday')}>
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cockpit.crewToday')}</h3>
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {rows.map((row) => (
          <li key={row.employeePartyId} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="h-2 w-2 rounded-full bg-teal-500" aria-hidden />
            <span className="font-medium">{row.employeeName ?? t('cockpit.unknownWorker')}</span>
            <span className="text-slate-500">
              {t('cockpit.sinceTime', { since: row.since })}
              {row.costCodeRef ? ` · ${row.costCodeRef}` : ''}
            </span>
            {row.geoCheck === 'outside' ? (
              <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                {t('cockpit.geoOutside')}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
