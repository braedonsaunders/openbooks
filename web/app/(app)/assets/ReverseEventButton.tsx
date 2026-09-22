'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { History } from 'lucide-react'
import { Button, Input, Label, Popover, Select, Textarea } from '@openbooks/ui'
import { useBusinessToday } from '../../../components/business-date-provider'

type EventKindKey = 'revalued' | 'impaired' | 'disposed' | 'written_off' | 'reversed' | 'unknown'
type BlockReasonKey = 'already_reversed' | 'accounting_change' | 'entry_not_posted' | 'later_event' | 'no_reversal_workflow'

interface CandidateEvent {
  id: string
  kind: string
  occurredOn: string
  amount: string | null
  entryNumber: string
  postingDate: string
  entryStatus: string
  reversible: boolean
  blockReason: BlockReasonKey | null
  laterKind: string | null
}

/** Keep API kind codes behind the translation catalog; unknown codes must never render raw. */
function eventKindKey(kind: unknown): EventKindKey {
  switch (kind) {
    case 'revalued':
    case 'impaired':
    case 'disposed':
    case 'written_off':
    case 'reversed':
      return kind
    default:
      return 'unknown'
  }
}

/** Reverse a posted disposal or remeasurement through the engine reversal. */
export function ReverseEventButton({ assetId }: { assetId: string }) {
  const t = useTranslations('assets')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const today = useBusinessToday()
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<CandidateEvent[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [eventId, setEventId] = useState('')
  const [date, setDate] = useState(today)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const selected = events?.find((e) => e.id === eventId) ?? null
  const kindLabel = (kind: unknown) => t(`reverseEvent.kinds.${eventKindKey(kind)}`)
  const blockText = (event: CandidateEvent) => {
    switch (event.blockReason) {
      case 'already_reversed':
      case 'accounting_change':
      case 'entry_not_posted':
      case 'no_reversal_workflow':
        return t(`reverseEvent.reasons.${event.blockReason}`)
      case 'later_event':
        return t('reverseEvent.reasons.later_event', { kind: kindLabel(event.laterKind) })
      default:
        return null
    }
  }

  async function show() {
    setBusy(true)
    setLoadError(false)
    try {
      const res = await fetch(`/api/assets/${encodeURIComponent(assetId)}/reverse-event`)
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? t('reverseEvent.loadFailed'))
      const data = (await res.json()) as { events?: CandidateEvent[] }
      const list = data.events ?? []
      setEvents(list)
      setEventId(list.find((e) => e.reversible)?.id ?? list[0]?.id ?? '')
      setOpen(true)
    } catch (e) {
      setLoadError(true)
      toast.error(e instanceof Error && e.message ? e.message : t('reverseEvent.loadFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    if (!selected?.reversible) return
    if (reason.trim().length < 8) {
      toast.error(t('reverseEvent.reasonTooShort'))
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/assets/${encodeURIComponent(assetId)}/reverse-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: selected.id, date, reason: reason.trim() }),
      })
      if (!res.ok) { const failure = await res.json().catch(() => ({})); throw new Error(failure.error ?? tCommon('feedback.saveFailed')) }
      toast.success(t('reverseEvent.done'))
      setOpen(false)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : tCommon('feedback.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="outline" onClick={show} disabled={busy}>
          <History size={15} className="mr-1.5" />
          {t('reverseEvent.label')}
        </Button>
      }
    >
      <div className="w-80 space-y-3 p-3">
        {events?.length ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="rev-event">{t('reverseEvent.event')}</Label>
              <Select id="rev-event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
                {events.map((e) => (
                  <option key={e.id} value={e.id} disabled={!e.reversible}>
                    {kindLabel(e.kind)} · {e.occurredOn} · {e.entryNumber}
                  </option>
                ))}
              </Select>
              {selected && !selected.reversible && blockText(selected) ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">{blockText(selected)}</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rev-date">{t('reverseEvent.date')}</Label>
              <Input id="rev-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rev-reason">{t('reverseEvent.reason')}</Label>
              <Textarea id="rev-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Button className="w-full" onClick={submit} disabled={busy || !selected?.reversible}>
              {busy ? t('reverseEvent.working') : t('reverseEvent.action')}
            </Button>
          </>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {loadError ? t('reverseEvent.loadFailed') : t('reverseEvent.empty')}
          </p>
        )}
      </div>
    </Popover>
  )
}
