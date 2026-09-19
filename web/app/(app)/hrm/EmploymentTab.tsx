'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Label } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../lib/api-error'

/**
 * The employee drawer's Employment tab — the ONE place the native
 * employment record is read, living on the native employee entity (no
 * parallel page). Shows the employment's episodes, the effective
 * assignment as-of a date picker (server-resolved through the canonical
 * read service), the recorded-vs-effective stamps behind each row, and the
 * employment's change requests with their revision binding and approval
 * link. Computed refusals (ambiguity, missing version) render as refusals —
 * never an empty state pretending to be data.
 */

type Episode = {
  versionId: string
  versionNo: number
  status: string
  effectiveFrom: string
  effectiveTo: string | null
  recordedAt: string
  recordedUntil: string | null
}

type Assignment = {
  assignmentKey: string
  jobTitle: string | null
  departmentId: string | null
  fte: string
  isPrimary: boolean
  effectiveFrom: string
  effectiveTo: string | null
  recordedAt: string
  recordedUntil: string | null
}

type AsOf = {
  version: { versionNo: number; status: string; effectiveFrom: string; effectiveTo: string | null; recordedAt: string; recordedUntil: string | null }
  assignments: Assignment[]
}

type ChangeRequest = {
  id: string
  status: string
  requestRevision: number
  expectedEmploymentRevision: number
  submittedAt: string | null
  flowRunId: string | null
}

type RecordState = {
  status: 'loading' | 'ready' | 'refused' | 'error'
  episodes: Episode[]
  asOf: AsOf | null
  asOfRefusal: { code: string; message: string } | null
  changeRequests: ChangeRequest[]
  refusalMessage: string | null
}

function todayCivil(): string {
  return new Date().toISOString().slice(0, 10)
}

export function EmploymentTab({ employmentId }: { employmentId: string }) {
  const t = useTranslations('hrm')
  const [date, setDate] = useState(todayCivil)
  const [state, setState] = useState<RecordState>({
    status: 'loading', episodes: [], asOf: null, asOfRefusal: null, changeRequests: [], refusalMessage: null,
  })
  const requestId = useRef(0)

  // A sequence guard drops stale responses so an older as-of never
  // overwrites a newer date's resolution.
  useEffect(() => {
    const current = (requestId.current += 1)
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/hrm/employments/${employmentId}?effectiveDate=${date}`)
        // The status is checked before the body is parsed: a non-JSON error
        // body must surface the failure, never a SyntaxError from res.json().
        if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed to load the employment record'))
        const j = await res.json()
        if (cancelled || requestId.current !== current) return
        const record = j.record ?? {}
        setState({
          status: 'ready',
          episodes: Array.isArray(record.episodes) ? record.episodes : [],
          asOf: record.asOf ?? null,
          asOfRefusal: record.asOfRefusal ?? null,
          changeRequests: Array.isArray(record.changeRequests) ? record.changeRequests : [],
          refusalMessage: null,
        })
      } catch (e) {
        if (cancelled || requestId.current !== current) return
        const message = (e as Error).message
        toast.error(message)
        setState((s) => ({ ...s, status: 'error', refusalMessage: message }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [employmentId, date])

  // Catalog-backed enum labels with a raw fallback: a status the catalog
  // does not know yet renders as its stored value, never a raw key path.
  const employmentStatus = (status: string): string =>
    t.has(`employment.status.${status}`) ? t(`employment.status.${status}`) : status
  const requestStatus = (status: string): string =>
    t.has(`employment.changeRequests.statusNames.${status}`) ? t(`employment.changeRequests.statusNames.${status}`) : status
  const window = (from: string, to: string | null): string => `${from} → ${to ?? t('employment.episodes.present')}`

  if (state.status === 'loading') {
    return (
      <div className="space-y-6 p-1" aria-busy="true">
        <div className="h-6 w-40 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
        <div className="h-24 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="space-y-6 p-1">
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">
          {state.refusalMessage}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-7 p-1">
      <section aria-label={t('employment.episodes.title')}>
        <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t('employment.episodes.title')}
        </h3>
        {state.episodes.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('employment.episodes.empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="py-1.5 pr-3 text-left font-medium">{t('employment.episodes.status')}</th>
                <th className="py-1.5 pr-3 text-left font-medium">{t('employment.episodes.effective')}</th>
                <th className="py-1.5 text-left font-medium">{t('employment.episodes.recorded')}</th>
              </tr>
            </thead>
            <tbody>
              {state.episodes.map((episode) => (
                <tr key={episode.versionId} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="py-1.5 pr-3 font-medium text-slate-700 dark:text-slate-200">
                    {employmentStatus(episode.status)}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums text-slate-500 dark:text-slate-400">
                    {window(episode.effectiveFrom, episode.effectiveTo)}
                  </td>
                  <td className="py-1.5 tabular-nums text-slate-500 dark:text-slate-400">
                    {window(episode.recordedAt, episode.recordedUntil)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label={t('employment.asOf.title')}>
        <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t('employment.asOf.title')}
        </h3>
        <div className="mb-3 w-44 space-y-1.5">
          <Label htmlFor="employment-asof-date">{t('employment.asOf.dateLabel')}</Label>
          <input
            id="employment-asof-date"
            type="date"
            value={date}
            onChange={(event) => event.target.value && setDate(event.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
        </div>
        {state.asOf ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-700 dark:text-slate-300">
              <span className="font-medium">{employmentStatus(state.asOf.version.status)}</span>
              {' · '}
              <span className="tabular-nums">
                {window(state.asOf.version.effectiveFrom, state.asOf.version.effectiveTo)}
              </span>
            </p>
            {state.asOf.assignments.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('employment.assignments.empty')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    <th className="py-1.5 pr-3 text-left font-medium">{t('employment.assignments.jobTitle')}</th>
                    <th className="py-1.5 pr-3 text-left font-medium">{t('employment.assignments.primary')}</th>
                    <th className="py-1.5 pr-3 text-right font-medium">{t('employment.assignments.fte')}</th>
                    <th className="py-1.5 pr-3 text-left font-medium">{t('employment.assignments.effective')}</th>
                    <th className="py-1.5 text-left font-medium">{t('employment.assignments.recorded')}</th>
                  </tr>
                </thead>
                <tbody>
                  {state.asOf.assignments.map((assignment) => (
                    <tr key={assignment.assignmentKey} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="py-1.5 pr-3 font-medium text-slate-700 dark:text-slate-200">
                        {assignment.jobTitle ?? '—'}
                      </td>
                      <td className="py-1.5 pr-3 text-slate-500 dark:text-slate-400">
                        {assignment.isPrimary ? t('employment.assignments.primaryYes') : ''}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500 dark:text-slate-400">
                        {assignment.fte}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums text-slate-500 dark:text-slate-400">
                        {window(assignment.effectiveFrom, assignment.effectiveTo)}
                      </td>
                      <td className="py-1.5 tabular-nums text-slate-500 dark:text-slate-400">
                        {window(assignment.recordedAt, assignment.recordedUntil)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : state.asOfRefusal ? (
          <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900 dark:bg-amber-950/50">
            <p className="font-semibold text-amber-900 dark:text-amber-100">
              {t('employment.asOf.refusalTitle')} · {state.asOfRefusal.code}
            </p>
            <p className="mt-1 text-amber-800 dark:text-amber-200">{state.asOfRefusal.message}</p>
          </div>
        ) : null}
      </section>

      <section aria-label={t('employment.changeRequests.title')}>
        <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t('employment.changeRequests.title')}
        </h3>
        {state.changeRequests.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('employment.changeRequests.empty')}</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {state.changeRequests.map((request) => (
              <li key={request.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  {requestStatus(request.status)}
                </span>
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  {t('employment.changeRequests.bindingValue', {
                    request: request.requestRevision,
                    expected: request.expectedEmploymentRevision,
                  })}
                </span>
                {request.submittedAt ? (
                  <span className="text-xs tabular-nums text-slate-400 dark:text-slate-500">
                    {t('employment.changeRequests.submitted')} · {request.submittedAt}
                  </span>
                ) : null}
                <span className="ml-auto text-sm">
                  {request.flowRunId ? (
                    <Link href="/approvals" className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                      {t('employment.changeRequests.viewInApprovals')}
                    </Link>
                  ) : (
                    <span className="text-xs text-slate-400 dark:text-slate-500">
                      {t('employment.changeRequests.noRun')}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
