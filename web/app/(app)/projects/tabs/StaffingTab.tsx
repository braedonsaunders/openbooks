'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { TieOutTable } from '../../resourcing/TieOutTable'
import type { PlanVsActualRow } from '@/lib/resourcing/tie-out'

/**
 * The project Staffing tab.
 *
 * Plan vs approved time per person-week for this project, loaded lazily like
 * the Schedule tab: the drawer opens instantly and the tab fetches its own
 * rows, so opening a project never waits on staffing figures. Every state
 * update sits in a promise continuation, never synchronously in an effect
 * body.
 */
export function StaffingTab({ projectId }: { projectId: string }) {
  const t = useTranslations('resourcing.cockpit')
  const tCommon = useTranslations('common')
  const [rows, setRows] = useState<PlanVsActualRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    return fetch(`/api/resourcing/projects/${encodeURIComponent(projectId)}/staffing`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string; error?: string; remedy?: string } | null
          setError([body?.message ?? body?.error, body?.remedy].filter(Boolean).join(' — ') || tCommon('feedback.loadFailed'))
          setRows([])
          return
        }
        const body = (await res.json()) as { rows: PlanVsActualRow[] }
        setError(null)
        setRows(body.rows)
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : tCommon('feedback.loadFailed'))
        setRows([])
      })
  }, [projectId, tCommon])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!rows) {
    return <div className="h-96 animate-pulse rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900" />
  }

  if (rows.length === 0 && !error) {
    return <p className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">{t('tieout.empty')}</p>
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}
      <TieOutTable
        rows={rows}
        labels={{
          person: t('tieout.person'),
          week: t('tieout.week'),
          planned: t('tieout.planned'),
          approved: t('tieout.approved'),
          variance: t('tieout.variance'),
          capacity: t('tieout.capacity'),
          evidence: t('tieout.evidence'),
          empty: t('tieout.empty'),
          noCapacity: t('tieout.noCapacity'),
          overallocated: t('tieout.overallocated'),
          assignments: t('tieout.assignments'),
          absences: t('tieout.absences'),
          leaveRequest: t('tieout.leaveRequest'),
          holidays: t('tieout.holidays'),
          scheduleTier: t('tieout.scheduleTier'),
        }}
      />
    </div>
  )
}
