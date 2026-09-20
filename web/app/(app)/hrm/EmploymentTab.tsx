'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../lib/api-error'
import { ChangeRequestActions } from './ChangeRequestActions'
import { ChangeRequestDrawer } from './ChangeRequestDrawer'
import { ExitRecordForm } from './performance/ExitRecordForm'

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

type ExitRecord = {
  id: string
  reasonKind: string
  isVoluntary: boolean
  destination: string | null
  notes: string | null
}

type ExitState = {
  status: 'hidden' | 'loading' | 'ready' | 'error'
  record: ExitRecord | null
  message: string | null
type BenefitElection = {
  planCode: string
  planName: string
  coverageLabel: string | null
  status: string
  employeeAmountPerPeriod: string | null
  employerAmountPerPeriod: string | null
  currency: string

type BenefitDependent = {
  displayName: string
  relationship: string
}

type RecordState = {
  status: 'loading' | 'ready' | 'refused' | 'error'
  episodes: Episode[]
  asOf: AsOf | null
  asOfRefusal: { code: string; message: string } | null
  changeRequests: ChangeRequest[]
  refusalMessage: string | null
  benefits: 'hidden' | 'loading' | 'ready'
  benefitElections: BenefitElection[]
  benefitDependents: BenefitDependent[]
}

function todayCivil(): string {
  return new Date().toISOString().slice(0, 10)
}

export function EmploymentTab({
  employmentId,
  canManageHrm,
  canReadExits = false,
  canRecordExit = false,
  departmentOptions = [],
}: {
  employmentId: string
  /** hrm.employment.manage — readers see the request list only, without authoring actions. */
  canManageHrm: boolean
  /** hrm.retention.read — readers see the exit record. */
  canReadExits?: boolean
  /** hrm.performance.manage — HR records and corrects the exit. */
  canRecordExit?: boolean
  departmentOptions?: { value: string; label: string }[]
}) {
  const t = useTranslations('hrm')
  const [date, setDate] = useState(todayCivil)
  const [revision, setRevision] = useState(0)
  const [proposing, setProposing] = useState(false)
  const [exit, setExit] = useState<ExitState>({ status: 'hidden', record: null, message: null })
  const [state, setState] = useState<RecordState>({
    status: 'loading', episodes: [], asOf: null, asOfRefusal: null, changeRequests: [], refusalMessage: null,
    benefits: 'loading', benefitElections: [], benefitDependents: [],
  })
  const requestId = useRef(0)
  const reload = (): void => {
    setRevision((current) => current + 1)
  }

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
          benefits: 'loading',
          benefitElections: [],
          benefitDependents: [],
        })
        // Benefits ride the benefits APIs beside the record: a 403 (no
        // benefits grant) hides the section instead of failing the tab —
        // the employment record is readable without benefits access.
        try {
          const [enrollmentsRes, dependentsRes] = await Promise.all([
            fetch(`/api/hrm/enrollments?employmentId=${employmentId}`),
            fetch(`/api/hrm/dependents?employmentId=${employmentId}`),
          ])
          if (cancelled || requestId.current !== current) return
          if (enrollmentsRes.status === 403 || dependentsRes.status === 403) {
            setState((s) => ({ ...s, benefits: 'hidden' }))
            return
          }
          if (!enrollmentsRes.ok) throw new Error(await readApiErrorMessage(enrollmentsRes, 'failed to load benefits'))
          if (!dependentsRes.ok) throw new Error(await readApiErrorMessage(dependentsRes, 'failed to load benefits'))
          const enrollments = (await enrollmentsRes.json()) as { enrollments?: BenefitElection[] }
          const dependents = (await dependentsRes.json()) as { dependents?: BenefitDependent[] }
          if (cancelled || requestId.current !== current) return
          setState((s) => ({
            ...s,
            benefits: 'ready',
            benefitElections: Array.isArray(enrollments.enrollments) ? enrollments.enrollments : [],
            benefitDependents: Array.isArray(dependents.dependents) ? dependents.dependents : [],
          }))
        } catch {
          if (cancelled || requestId.current !== current) return
          setState((s) => ({ ...s, benefits: 'hidden' }))
        }
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
  }, [employmentId, date, revision])

  // The exit record loads once the as-of version reads terminated: the
  // record describes a termination, and an unterminated employment shows
  // no exit section at all.
  const terminated = state.asOf?.version.status === 'terminated'
  const showExit = terminated && (canReadExits || canRecordExit)
  useEffect(() => {
    if (!showExit) {
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/hrm/exit-records?employmentId=${employmentId}`)
        if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed to load the exit record'))
        const j = await res.json()
        if (cancelled) return
        const exits = Array.isArray(j.exits) ? j.exits : []
        setExit({ status: 'ready', record: exits[0] ?? null, message: null })
      } catch (e) {
        if (cancelled) return
        const message = (e as Error).message
        toast.error(message)
        setExit({ status: 'error', record: null, message })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [employmentId, showExit, revision])

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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('employment.episodes.status')}</TableHead>
                <TableHead>{t('employment.episodes.effective')}</TableHead>
                <TableHead>{t('employment.episodes.recorded')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.episodes.map((episode) => (
                <TableRow key={episode.versionId}>
                  <TableCell className="font-medium">{employmentStatus(episode.status)}</TableCell>
                  <TableCell className="tabular-nums text-slate-500 dark:text-slate-400">
                    {window(episode.effectiveFrom, episode.effectiveTo)}
                  </TableCell>
                  <TableCell className="tabular-nums text-slate-500 dark:text-slate-400">
                    {window(episode.recordedAt, episode.recordedUntil)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('employment.assignments.jobTitle')}</TableHead>
                    <TableHead>{t('employment.assignments.primary')}</TableHead>
                    <TableHead className="text-right">{t('employment.assignments.fte')}</TableHead>
                    <TableHead>{t('employment.assignments.effective')}</TableHead>
                    <TableHead>{t('employment.assignments.recorded')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.asOf.assignments.map((assignment) => (
                    <TableRow key={assignment.assignmentKey}>
                      <TableCell className="font-medium">{assignment.jobTitle ?? '—'}</TableCell>
                      <TableCell className="text-slate-500 dark:text-slate-400">
                        {assignment.isPrimary ? t('employment.assignments.primaryYes') : ''}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-slate-500 dark:text-slate-400">{assignment.fte}</TableCell>
                      <TableCell className="tabular-nums text-slate-500 dark:text-slate-400">
                        {window(assignment.effectiveFrom, assignment.effectiveTo)}
                      </TableCell>
                      <TableCell className="tabular-nums text-slate-500 dark:text-slate-400">
                        {window(assignment.recordedAt, assignment.recordedUntil)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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

      {showExit ? (
        <section aria-label={t('employment.exit.title')}>
          <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('employment.exit.title')}
          </h3>
          {exit.status === 'hidden' || exit.status === 'loading' ? (
            <div className="h-6 w-40 animate-pulse rounded bg-slate-100 dark:bg-slate-800" aria-busy="true" />
          ) : exit.status === 'error' ? (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">
              {exit.message}
            </div>
          ) : exit.record ? (
            <div className="space-y-3">
              <p className="text-sm text-slate-700 dark:text-slate-300">
                <span className="font-medium">{exit.record.reasonKind}</span>
                {' · '}
                {exit.record.isVoluntary ? t('performance.exitVoluntaryYes') : t('performance.exitVoluntaryNo')}
                {exit.record.destination ? ` · ${exit.record.destination}` : null}
              </p>
              {exit.record.notes ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">{exit.record.notes}</p>
              ) : null}
              {canRecordExit ? (
                <ExitRecordForm employmentId={employmentId} existing={exit.record} />
              ) : null}
            </div>
          ) : canRecordExit ? (
            <ExitRecordForm employmentId={employmentId} existing={null} />
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('employment.exit.empty')}</p>
          )}
        </section>
      ) : null}
      <section aria-label={t('employment.changeRequests.title')}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('employment.changeRequests.title')}
          </h3>
          {canManageHrm ? (
            <Button size="sm" variant="outline" onClick={() => setProposing(true)}>
              {t('employment.changeRequests.proposeButton')}
            </Button>
          ) : null}
        </div>
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
                {canManageHrm ? (
                  <span className="basis-full">
                    <ChangeRequestActions
                      request={{ id: request.id, status: request.status }}
                      employmentId={employmentId}
                      departmentOptions={departmentOptions}
                      onChanged={reload}
                    />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {state.benefits !== 'hidden' ? (
      <section aria-label={t('employment.benefits.title')}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('employment.benefits.title')}
          </h3>
          <Link href="/hrm/benefits" className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-300">
            {t('employment.benefits.viewAll')}
          </Link>
        </div>
        {state.benefits === 'ready' && state.benefitElections.length === 0 && state.benefitDependents.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('employment.benefits.empty')}</p>
        ) : null}
        {state.benefits === 'ready' && state.benefitElections.length > 0 ? (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {state.benefitElections.map((election) => (
              <li key={election.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  {election.planName}
                  {election.coverageLabel ? ` · ${election.coverageLabel}` : ''}
                </span>
                <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
                  {election.employeeAmountPerPeriod ?? '–'} / {election.employerAmountPerPeriod ?? '–'} {election.currency}
                </span>
                <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  {t.has(`benefits.statusNames.${election.status}`) ? t(`benefits.statusNames.${election.status}`) : election.status}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {state.benefits === 'ready' && state.benefitDependents.length > 0 ? (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            {t('employment.benefits.dependents', { count: state.benefitDependents.length, names: state.benefitDependents.map((d) => d.displayName).join(', ') })}
          </p>
        ) : null}
      </section>
      ) : null}
      {proposing && canManageHrm ? (
        <ChangeRequestDrawer
          employmentId={employmentId}
          initialRequest={null}
          departmentOptions={departmentOptions}
          onClose={() => setProposing(false)}
          onSaved={reload}
        />
      ) : null}
    </div>
  )
}
