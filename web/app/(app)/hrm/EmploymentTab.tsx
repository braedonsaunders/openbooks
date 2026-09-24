'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../lib/api-error'
import { useBusinessToday } from '../../../components/business-date-provider'
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
  revision: number
}

type ExitState = {
  status: 'hidden' | 'loading' | 'ready' | 'error'
  record: ExitRecord | null
  message: string | null
}

type BenefitElection = {
  id: string
  planCode: string
  planName: string
  coverageLabel: string | null
  status: string
  employeeAmountPerPeriod: string | null
  employerAmountPerPeriod: string | null
  currency: string
}

type BenefitDependent = {
  id: string
  displayName: string
  relationship: string
}

type EmploymentQualification = {
  id: string
  typeCode: string
  typeName: string
  status: string
  expiresOn: string | null
}

type DrawerFeedback = {
  id: string
  kind: string
  visibility: string
  body: string
  recordedAt: string
}

type DrawerCompetency = {
  sectionTitle: string
  competencyName: string
  assessedRating: string | null
  levels: { label: string; expectation: string }[]
}

type RecordState = {
  status: 'loading' | 'ready' | 'refused' | 'error'
  episodes: Episode[]
  asOf: AsOf | null
  asOfRefusal: { code: string; message: string } | null
  changeRequests: ChangeRequest[]
  refusalMessage: string | null
  benefits: 'hidden' | 'loading' | 'ready' | 'error'
  benefitElections: BenefitElection[]
  benefitDependents: BenefitDependent[]
  benefitsError: string | null
  qualifications: 'hidden' | 'loading' | 'ready' | 'error'
  employmentQualifications: EmploymentQualification[]
  qualificationsError: string | null
  // HR-17: visibility-filtered feedback and expected-vs-assessed
  // competencies. A 403/404 hides the section — the record is readable
  // without continuous-performance access. Anything else is an error with
  // retry, never a silent absence.
  continuous: 'hidden' | 'loading' | 'ready' | 'error'
  feedback: DrawerFeedback[]
  competencies: DrawerCompetency[]
  continuousError: string | null
}

/**
 * A beside-the-record section that failed to load (a 500, a network drop —
 * anything but 403/404) says so with a retry, instead of hiding as if the
 * viewer had no access.
 */
function SectionError({ message, onRetry, retryLabel }: { message: string; onRetry: () => void; retryLabel: string }) {
  return (
    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
      {message}{' '}
      <Button variant="ghost" size="sm" onClick={onRetry}>
        {retryLabel}
      </Button>
    </p>
  )
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
  const tCommon = useTranslations('common')
  // New dated records default to the org's business day from the server,
  // never the browser's UTC day (tomorrow after 5pm Pacific).
  const [date, setDate] = useState(useBusinessToday())
  const [revision, setRevision] = useState(0)
  const [proposing, setProposing] = useState(false)
  const [exit, setExit] = useState<ExitState>({ status: 'hidden', record: null, message: null })
  const [state, setState] = useState<RecordState>({
    status: 'loading', episodes: [], asOf: null, asOfRefusal: null, changeRequests: [], refusalMessage: null,
    benefits: 'loading', benefitElections: [], benefitDependents: [], benefitsError: null,
    qualifications: 'loading', employmentQualifications: [], qualificationsError: null,
    continuous: 'loading', feedback: [], competencies: [], continuousError: null,
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
          benefitsError: null,
          qualifications: 'loading',
          employmentQualifications: [],
          qualificationsError: null,
          continuous: 'loading',
          feedback: [],
          competencies: [],
          continuousError: null,
        })
        // Qualifications ride the qualifications API beside the record:
        // a 403/404 (no grant, or the feature off) hides the section
        // instead of failing the tab — the employment record is readable
        // without qualification access. Anything else is an error with
        // retry: a 500 must never look like no access.
        try {
          const qualificationsRes = await fetch(`/api/hrm/qualifications?employmentId=${employmentId}`)
          if (cancelled || requestId.current !== current) return
          if (qualificationsRes.status === 403 || qualificationsRes.status === 404) {
            setState((s) => ({ ...s, qualifications: 'hidden', employmentQualifications: [], qualificationsError: null }))
          } else {
            if (!qualificationsRes.ok) throw new Error(await readApiErrorMessage(qualificationsRes, t('employment.qualifications.loadFailed')))
            const quals = (await qualificationsRes.json()) as {
              qualifications?: { id: string; type?: { code?: string; name?: string }; status?: string; expiresOn?: string | null }[]
            }
            if (cancelled || requestId.current !== current) return
            const list = Array.isArray(quals.qualifications) ? quals.qualifications : []
            setState((s) => ({
              ...s,
              qualifications: 'ready',
              qualificationsError: null,
              employmentQualifications: list.map((q) => ({
                id: q.id,
                typeCode: q.type?.code ?? '',
                typeName: q.type?.name ?? '',
                status: q.status ?? '',
                expiresOn: q.expiresOn ?? null,
              })),
            }))
          }
        } catch (e) {
          if (cancelled || requestId.current !== current) return
          setState((s) => ({
            ...s,
            qualifications: 'error',
            employmentQualifications: [],
            qualificationsError: e instanceof Error ? e.message : t('employment.qualifications.loadFailed'),
          }))
        }
        // Benefits ride the benefits APIs beside the record: a 403/404 leg
        // (no benefits grant, or the feature off) hides the section instead
        // of failing the tab — the employment record is readable without
        // benefits access, and a partial pair never renders as complete.
        // A failure that is not 403/404 is an error with retry.
        const benefitsForbidden = (res: Response): boolean => res.status === 403 || res.status === 404
        try {
          const [enrollmentsRes, dependentsRes] = await Promise.all([
            fetch(`/api/hrm/enrollments?employmentId=${employmentId}`),
            fetch(`/api/hrm/dependents?employmentId=${employmentId}`),
          ])
          if (cancelled || requestId.current !== current) return
          if (!enrollmentsRes.ok || !dependentsRes.ok) {
            const unexpected = [enrollmentsRes, dependentsRes].find((res) => !res.ok && !benefitsForbidden(res))
            if (unexpected) throw new Error(await readApiErrorMessage(unexpected, t('employment.benefits.loadFailed')))
            setState((s) => ({ ...s, benefits: 'hidden', benefitsError: null }))
            return
          }
          const enrollments = (await enrollmentsRes.json()) as { enrollments?: BenefitElection[] }
          const dependents = (await dependentsRes.json()) as { dependents?: BenefitDependent[] }
          if (cancelled || requestId.current !== current) return
          setState((s) => ({
            ...s,
            benefits: 'ready',
            benefitsError: null,
            benefitElections: Array.isArray(enrollments.enrollments) ? enrollments.enrollments : [],
            benefitDependents: Array.isArray(dependents.dependents) ? dependents.dependents : [],
          }))
        } catch (e) {
          if (cancelled || requestId.current !== current) return
          setState((s) => ({
            ...s,
            benefits: 'error',
            benefitsError: e instanceof Error ? e.message : t('employment.benefits.loadFailed'),
          }))
        }
        // HR-17: feedback (visibility-filtered by the service) and the
        // competency profile ride beside the record like benefits do: a
        // 403/404 leg hides the section, a failure that is not 403/404 is
        // an error with retry.
        const continuousForbidden = (res: Response): boolean => res.status === 403 || res.status === 404
        try {
          const [feedbackRes, profileRes] = await Promise.all([
            fetch(`/api/hrm/feedback?subjectEmploymentId=${employmentId}`),
            fetch(`/api/hrm/competency-profile?employmentId=${employmentId}`),
          ])
          if (cancelled || requestId.current !== current) return
          if (!feedbackRes.ok || !profileRes.ok) {
            const unexpected = [feedbackRes, profileRes].find((res) => !res.ok && !continuousForbidden(res))
            if (unexpected) throw new Error(await readApiErrorMessage(unexpected, t('employment.continuous.loadFailed')))
            setState((s) => ({ ...s, continuous: 'hidden', continuousError: null }))
            return
          }
          const fb = (await feedbackRes.json()) as { feedback?: DrawerFeedback[] }
          const cp = (await profileRes.json()) as { profile?: DrawerCompetency[] }
          if (cancelled || requestId.current !== current) return
          setState((s) => ({
            ...s,
            continuous: 'ready',
            continuousError: null,
            feedback: Array.isArray(fb.feedback) ? fb.feedback : [],
            competencies: Array.isArray(cp.profile) ? cp.profile : [],
          }))
        } catch (e) {
          if (cancelled || requestId.current !== current) return
          setState((s) => ({
            ...s,
            continuous: 'error',
            continuousError: e instanceof Error ? e.message : t('employment.continuous.loadFailed'),
          }))
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
  // t rides the deps so a locale switch re-resolves the section errors in
  // the new language with the same fetch.
  }, [employmentId, date, revision, t])

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
                    <Link href="/inbox" className="font-medium text-teal-700 hover:underline dark:text-teal-300">
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
                      // F3-36: this branch already renders inside the
                      // canManageHrm gate — the grant travels explicitly.
                      canManage={canManageHrm}
                      onChanged={reload}
                    />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {state.qualifications !== 'hidden' ? (
      <section aria-label={t('employment.qualifications.title')}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('employment.qualifications.title')}
          </h3>
          <Link href="/hrm/qualifications" className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-300">
            {t('employment.qualifications.viewAll')}
          </Link>
        </div>
        {state.qualifications === 'error' ? (
          <SectionError
            message={state.qualificationsError ?? t('employment.qualifications.loadFailed')}
            onRetry={reload}
            retryLabel={tCommon('actions.retry')}
          />
        ) : null}
        {state.qualifications === 'ready' && state.employmentQualifications.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('employment.qualifications.empty')}</p>
        ) : null}
        {state.qualifications === 'ready' && state.employmentQualifications.length > 0 ? (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {state.employmentQualifications.map((q) => (
              <li key={q.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  {q.typeCode}{q.typeName ? ` · ${q.typeName}` : ''}
                </span>
                <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
                  {q.expiresOn ?? '–'}
                </span>
                <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  {t.has(`qualifications.statusNames.${q.status}`) ? t(`qualifications.statusNames.${q.status}`) : q.status}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      ) : null}
      {state.continuous !== 'hidden' ? (
      <section aria-label={t('employment.continuous.title')}>
        <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t('employment.continuous.title')}
        </h3>
        {state.continuous === 'error' ? (
          <SectionError
            message={state.continuousError ?? t('employment.continuous.loadFailed')}
            onRetry={reload}
            retryLabel={tCommon('actions.retry')}
          />
        ) : null}
        {state.continuous === 'ready' && state.feedback.length > 0 ? (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {state.feedback.map((row) => (
              <li key={row.id} className="py-2">
                <p className="text-sm text-slate-700 dark:text-slate-200">{row.body}</p>
                <p className="mt-0.5 text-xs tabular-nums text-slate-400 dark:text-slate-500">
                  {row.kind} · {row.visibility} · {row.recordedAt.slice(0, 10)}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
        {state.continuous === 'ready' && state.competencies.length > 0 ? (
          <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
            {state.competencies.map((row) => (
              <li key={row.sectionTitle} className="py-2">
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  {row.competencyName}
                  {row.assessedRating ? ` · ${row.assessedRating}` : ''}
                </p>
                {row.levels.length > 0 ? (
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {row.levels.map((l) => `${l.label}: ${l.expectation}`).join(' · ')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      ) : null}
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
        {state.benefits === 'error' ? (
          <SectionError
            message={state.benefitsError ?? t('employment.benefits.loadFailed')}
            onRetry={reload}
            retryLabel={tCommon('actions.retry')}
          />
        ) : null}
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
