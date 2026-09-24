'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, Select, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

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
}) {
  const t = useTranslations('hrm')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [reason, setReason] = useState(existing?.reasonKind ?? 'resignation')
  const [voluntary, setVoluntary] = useState(existing?.isVoluntary ?? true)
  // F3-40: the interview travels as a pair (held date with interviewer),
  // prefilled from the stored record; empty sends nulls for both.
  const [interviewDate, setInterviewDate] = useState(existing?.interviewHeldOn ?? '')
  const [interviewerId, setInterviewerId] = useState(existing?.interviewerPartyId ?? '')
  const [interviewers, setInterviewers] = useState<{ value: string; label: string }[]>([])
  const [interviewersError, setInterviewersError] = useState<string | null>(null)
  const [destination, setDestination] = useState(existing?.destination ?? '')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The interviewer picker loads with the form: directory people holding
  // an employment, keyed by party — the record names its interviewer by
  // party, so employment ids would be the wrong ids. A picker failure is
  // an error with retry, never a silent empty list.
  async function readInterviewers(): Promise<{ value: string; label: string }[]> {
    const params = new URLSearchParams({ source: 'people', limit: '200' })
    if (existing?.interviewerPartyId) params.set('include', existing.interviewerPartyId)
    const res = await fetch(`/api/hrm/options?${params.toString()}`, { method: 'GET' })
    // res.ok first, always: the refusal names the missing grant.
    if (!res.ok) throw new Error(await readApiErrorMessage(res, t('performance.exitInterviewerFailed')))
    const payload = (await res.json().catch(() => ({}))) as {
      options?: { partyId?: unknown; label?: unknown }[]
    }
    const page = Array.isArray(payload.options) ? payload.options : []
    return page.flatMap((row) =>
      typeof row.partyId === 'string' && typeof row.label === 'string'
        ? [{ value: row.partyId, label: row.label }]
        : [],
    )
  }

  async function loadInterviewers(): Promise<void> {
    setInterviewersError(null)
    try {
      setInterviewers(await readInterviewers())
    } catch (e) {
      setInterviewersError((e as Error).message)
    }
  }
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const list = await readInterviewers()
        if (!cancelled) setInterviewers(list)
      } catch (e) {
        if (!cancelled) setInterviewersError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      router.refresh()
      setBusy(false)
    } catch {
      setError(t('performance.actionFailed'))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
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
              <Button variant="ghost" size="sm" onClick={() => void loadInterviewers()}>
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
