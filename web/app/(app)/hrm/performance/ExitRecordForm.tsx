'use client'

import { useState } from 'react'
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
    destination: string | null
    notes: string | null
    revision: number
  } | null
}) {
  const t = useTranslations('hrm')
  const router = useRouter()
  const [reason, setReason] = useState(existing?.reasonKind ?? 'resignation')
  const [voluntary, setVoluntary] = useState(existing?.isVoluntary ?? true)
  const [destination, setDestination] = useState(existing?.destination ?? '')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // A correction presents the revision it was read at: a stale
      // revision refuses instead of overwriting a newer correction.
      const body = {
        ...(existing ? { expectedRevision: existing.revision } : {}),
        reasonKind: reason,
        isVoluntary: voluntary,
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
