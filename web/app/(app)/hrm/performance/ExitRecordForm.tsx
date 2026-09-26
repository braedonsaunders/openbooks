'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, Select, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { useDirtyUrlDrawer } from '../../../../components/dirty-url-drawer'

const REASONS = [
  'resignation',
  'retirement',
  'end_of_contract',
  'dismissal',
  'redundancy',
  'mutual',
  'death',
  'other',
] as const

/**
 * The exit record form in the employee drawer's Employment tab: records
 * (or corrects) the one exit record for a terminated employment through
 * /api/hrm/exit-records. The interview travels as a pair (held date with
 * interviewer) — the service refuses a half interview by name and the
 * message renders as the error.
 */
export function ExitRecordForm({
  employmentId,
  existing,
  onSaved,
}: {
  employmentId: string
  existing: {
    id: string
    reasonKind: string
    isVoluntary: boolean
    interviewHeldOn: string | null
    interviewerPartyId: string | null
    destination: string | null
    notes: string | null
    revision: number
  } | null
  /**
   * Refetch hook for hosts that hold the record in client state (the
   * Employment tab fetches the exit record itself): after a record or a
   * correction, the stored revision moved, so the host must re-read
   * before the next submit — otherwise the next create reports "already
   * has an exit record" and the next correction fails stale-revision.
   * Server-rendered hosts omit it: router.refresh() re-runs their loader.
   */
  onSaved?: () => void
}) {
  const t = useTranslations('hrm')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [reason, setReason] = useState(existing?.reasonKind ?? 'resignation')
  const [voluntary, setVoluntary] = useState(existing?.isVoluntary ?? true)
  // The interview travels as a pair (held date with interviewer),
  // prefilled from the stored record; empty sends nulls for both.
  const [interviewDate, setInterviewDate] = useState(existing?.interviewHeldOn ?? '')
  const [interviewerId, setInterviewerId] = useState(existing?.interviewerPartyId ?? '')
  const [interviewers, setInterviewers] = useState<{ value: string; label: string }[]>([])
  const [interviewerQuery, setInterviewerQuery] = useState('')
  const [interviewersAttempt, setInterviewersAttempt] = useState(0)
  const interviewersRequestId = useRef(0)
  const storedInterviewer = existing?.interviewerPartyId ?? null
  const [interviewersError, setInterviewersError] = useState<string | null>(null)
  const [destination, setDestination] = useState(existing?.destination ?? '')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useDirtyUrlDrawer(
    reason !== (existing?.reasonKind ?? 'resignation') ||
      voluntary !== (existing?.isVoluntary ?? true) ||
      interviewDate !== (existing?.interviewHeldOn ?? '') ||
      interviewerId !== (existing?.interviewerPartyId ?? '') ||
      destination !== (existing?.destination ?? '') ||
      notes !== (existing?.notes ?? ''),
    busy,
  )

  // The interviewer picker loads with the form: directory people holding
  // an employment, keyed by party — the record names its interviewer by
  // party, so employment ids would be the wrong ids. A picker failure is
  // an error with retry, never a silent empty list. The request stays
  // inside the shared options contract (limits above 100 refuse with
  // 422), paging 100 with server-backed search so holders beyond the
  // first page stay selectable; a sequence guard drops stale responses.
  useEffect(() => {
    const id = (interviewersRequestId.current += 1)
    const params = new URLSearchParams({ source: 'people', limit: '100' })
    if (interviewerQuery.trim()) params.set('q', interviewerQuery.trim())
    if (storedInterviewer) params.set('include', storedInterviewer)
    fetch(`/api/hrm/options?${params.toString()}`, { method: 'GET' })
      .then(async (res) => {
        if (id !== interviewersRequestId.current) return
        // res.ok first, always: the refusal names the missing grant.
        if (!res.ok) throw new Error(await readApiErrorMessage(res, t('performance.exitInterviewerFailed')))
        const payload = (await res.json().catch(() => ({}))) as {
          options?: { partyId?: unknown; label?: unknown }[]
        }
        if (id !== interviewersRequestId.current) return
        const page = Array.isArray(payload.options) ? payload.options : []
        setInterviewers(
          page.flatMap((row) =>
            typeof row.partyId === 'string' && typeof row.label === 'string'
              ? [{ value: row.partyId, label: row.label }]
              : [],
          ),
        )
        setInterviewersError(null)
      })
      .catch((e: unknown) => {
        if (id !== interviewersRequestId.current) return
        setInterviewersError((e as Error).message)
      })
  }, [interviewerQuery, storedInterviewer, interviewersAttempt, t])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // A correction presents the revision it was read at: a stale
      // revision refuses instead of overwriting a newer correction.
      // The pair posts together or not at all: a half interview is the
      // service's named refusal, rendered below like any other refusal.
      const body = {
        ...(existing ? { expectedRevision: existing.revision } : {}),
        reasonKind: reason,
        isVoluntary: voluntary,
        interviewHeldOn: interviewDate !== '' ? interviewDate : null,
        interviewerPartyId: interviewerId !== '' ? interviewerId : null,
        destination: destination.trim().length > 0 ? destination.trim() : null,
        notes: notes.trim().length > 0 ? notes.trim() : null,
      }
      const res = existing
        ? await fetch(`/api/hrm/exit-records/${existing.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        : await fetch('/api/hrm/exit-records', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ employmentId, ...body }),
          })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t('performance.actionFailed')))
        setBusy(false)
        return
      }
      onSaved?.()
      router.refresh()
      setBusy(false)
    } catch {
      setError(t('performance.actionFailed'))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" inert={busy}>
      <div>
        <Label htmlFor="exit-reason">{t('performance.exitReason')}</Label>
        <Select id="exit-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`performance.exitReason_${r}`)}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="exit-voluntary">{t('performance.exitVoluntary')}</Label>
        <Select
          id="exit-voluntary"
          value={voluntary ? 'yes' : 'no'}
          onChange={(e) => setVoluntary(e.target.value === 'yes')}
        >
          <option value="yes">{t('performance.exitVoluntaryYes')}</option>
          <option value="no">{t('performance.exitVoluntaryNo')}</option>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="exit-interview-date">{t('performance.exitInterviewDate')}</Label>
          <Input
            id="exit-interview-date"
            type="date"
            value={interviewDate}
            onChange={(e) => setInterviewDate(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="exit-interviewer">{t('performance.exitInterviewer')}</Label>
          <Input
            id="exit-interviewer-search"
            value={interviewerQuery}
            onChange={(e) => {
              setInterviewerQuery(e.target.value)
              setInterviewersError(null)
            }}
            placeholder={t('performance.exitInterviewerSearch')}
            aria-label={t('performance.exitInterviewerSearch')}
            className="mb-1.5"
          />
          <Select id="exit-interviewer" value={interviewerId} onChange={(e) => setInterviewerId(e.target.value)}>
            <option value="">{t('performance.exitInterviewerPlaceholder')}</option>
            {interviewers.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          {interviewersError ? (
            <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
              {interviewersError}{' '}
              <Button variant="ghost" size="sm" onClick={() => setInterviewersAttempt((n) => n + 1)}>
                {tCommon('actions.retry')}
              </Button>
            </p>
          ) : null}
        </div>
      </div>
      <div>
        <Label htmlFor="exit-destination">{t('performance.exitDestination')}</Label>
        <Input id="exit-destination" value={destination} onChange={(e) => setDestination(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="exit-notes">{t('performance.exitNotes')}</Label>
        <Textarea id="exit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy}>
        {existing ? t('performance.saveExit') : t('performance.recordExit')}
      </Button>
    </form>
  )
}
