'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Check, CircleAlert, Loader2 } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { apiJson } from '@/lib/api-error'

export interface BulkApproveWeek {
  employeeId: string
  weekStart: string
  personName: string
  hours: string
}

interface WeekResult {
  employee: string
  week: string
  ok: boolean
  error?: string
  code?: string
  remedy?: string
}

/**
 * Bulk approval for submitted weeks awaiting a direct decision. Each
 * selected week approves through the native approval command in its own
 * transaction; refused weeks report their typed refusal and remedy beside
 * the approved count — partial success is explicit, never silent. Weeks
 * owned by an approval flow never appear here: they are decided through
 * their gates.
 */
export function TimesheetBulkApprove({ weeks }: { weeks: BulkApproveWeek[] }) {
  const t = useTranslations('timesheets')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [working, setWorking] = useState(false)
  const [results, setResults] = useState<WeekResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Synchronous re-entry fence: state lands on the next render, so two rapid
  // clicks would both read working=false and approve twice.
  const inflight = useRef(false)

  if (weeks.length === 0) return null
  const keyOf = (week: BulkApproveWeek) => `${week.employeeId}:${week.weekStart}`
  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const toggleAll = () => {
    setSelected((current) => (current.size === weeks.length ? new Set() : new Set(weeks.map(keyOf))))
  }

  async function approveSelected() {
    const chosen = weeks.filter((week) => selected.has(keyOf(week)))
    if (chosen.length === 0 || working || inflight.current) return
    inflight.current = true
    setWorking(true)
    setError(null)
    try {
      const body = await apiJson<{ results?: WeekResult[] }>('/api/timesheets/approve/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ weeks: chosen.map((week) => ({ employee: week.employeeId, week: week.weekStart })) }),
      }, t('grid.networkError'))
      setResults(body.results ?? [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('grid.networkError'))
    } finally {
      inflight.current = false
      setWorking(false)
    }
  }

  const approved = results?.filter((result) => result.ok) ?? []
  const refused = results?.filter((result) => !result.ok) ?? []
  const labelOf = (result: WeekResult) => {
    const week = weeks.find((candidate) => candidate.employeeId === result.employee && candidate.weekStart === result.week)
    return week ? `${week.personName} · ${week.weekStart}` : `${result.employee} · ${result.week}`
  }

  return (
    <section aria-label={t('bulk.title')} className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('bulk.title')}</h2>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t('bulk.description')}</p>
      <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
        {weeks.map((week) => {
          const key = keyOf(week)
          return (
            <li key={key} className="flex items-center gap-3 py-2">
              <input
                type="checkbox"
                checked={selected.has(key)}
                onChange={() => toggle(key)}
                aria-label={`${week.personName} · ${week.weekStart}`}
                className="h-4 w-4 rounded border-slate-300 accent-teal-700"
              />
              <div className="min-w-0 flex-1">
                <Link
                  href={`/timesheets?timesheet=${week.employeeId}:${week.weekStart}`}
                  className="text-sm font-medium text-slate-900 hover:underline dark:text-slate-100"
                >
                  {week.personName}
                </Link>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t('list.week')} {week.weekStart} · {week.hours}h
                </p>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={toggleAll}>
          {selected.size === weeks.length ? t('bulk.clear') : t('bulk.selectAll')}
        </Button>
        <Button type="button" size="sm" disabled={working || selected.size === 0} onClick={() => void approveSelected()}>
          {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {working ? t('bulk.approving') : t('bulk.approve')}
        </Button>
      </div>
      {error ? <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p> : null}
      {results ? (
        <div className="mt-3 space-y-2">
          {approved.length > 0 ? (
            <p role="status" className="flex items-center gap-1.5 text-xs font-medium text-teal-700 dark:text-teal-300">
              <Check className="h-3.5 w-3.5" />{t('bulk.approved', { count: approved.length })}
            </p>
          ) : null}
          {refused.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-amber-700 dark:text-amber-300">{t('bulk.refused', { count: refused.length })}</p>
              <ul className="mt-1 space-y-1.5">
                {refused.map((result, index) => (
                  <li key={index} className="flex items-start gap-1.5 text-xs">
                    <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    <div className="min-w-0">
                      <p className="font-medium text-slate-800 dark:text-slate-200">{labelOf(result)}</p>
                      <p className="text-slate-500 dark:text-slate-400">{result.error}</p>
                      {result.remedy ? <p className="text-slate-500 dark:text-slate-400">{result.remedy}</p> : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
