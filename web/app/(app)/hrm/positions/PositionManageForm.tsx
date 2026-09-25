'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, Select, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

export interface PositionManageProps {
  positionId: string
  effectiveDate: string
  title: string
  plannedFte: string
  status: string
  periods: { value: string; label: string; fundedFte: string }[]
  labels: {
    revise: string
    fund: string
    close: string
    title: string
    plannedFte: string
    status: string
    effectiveDate: string
    period: string
    fundedFte: string
    reason: string
    failed: string
    saved: string
  }
}

const REVISION_STATUSES = ['planned', 'open', 'filled', 'frozen'] as const

/** Revision, funding, and closure all post through the position PATCH contract. */
export function PositionManageForm({ positionId, effectiveDate, title: initialTitle, plannedFte: initialFte, status: initialStatus, periods, labels }: PositionManageProps) {
  const t = useTranslations('hrm')
  const router = useRouter()
  const [title, setTitle] = useState(initialTitle)
  const [plannedFte, setPlannedFte] = useState(initialFte)
  const [status, setStatus] = useState(initialStatus)
  const [revisionDate, setRevisionDate] = useState(effectiveDate)
  const [periodId, setPeriodId] = useState(periods[0]?.value ?? '')
  const [fundedFte, setFundedFte] = useState(periods[0]?.fundedFte ?? initialFte)
  const [closeDate, setCloseDate] = useState(effectiveDate)
  const [revisionReason, setRevisionReason] = useState('')
  const [fundingReason, setFundingReason] = useState('')
  const [closeReason, setCloseReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  async function submit(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      const response = await fetch(`/api/hrm/positions/${positionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        setError(await readApiErrorMessage(response, labels.failed))
        return
      }
      setSaved(labels.saved)
      router.refresh()
    } catch {
      setError(labels.failed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800" aria-label={labels.revise}>
      <h3 className="text-sm font-semibold">{labels.revise}</h3>
      <form className="space-y-2" onSubmit={(event) => {
        event.preventDefault()
        void submit({ action: 'revise', title, plannedFte: plannedFte.trim(), status, effectiveFrom: revisionDate, reason: revisionReason.trim() })
      }}>
        <div>
          <Label htmlFor="position-revise-title">{labels.title}</Label>
          <Input id="position-revise-title" value={title} required maxLength={240} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
        </div>
        <div>
          <Label htmlFor="position-revise-fte">{labels.plannedFte}</Label>
          <Input id="position-revise-fte" inputMode="decimal" value={plannedFte} required disabled={busy} onChange={(event) => setPlannedFte(event.target.value)} />
        </div>
        <div>
          <Label htmlFor="position-revise-status">{labels.status}</Label>
          <Select id="position-revise-status" value={status} disabled={busy} onChange={(event) => setStatus(event.target.value)}>
            {REVISION_STATUSES.map((value) => <option key={value} value={value}>{t(`positions.status${value[0]!.toUpperCase()}${value.slice(1)}`)}</option>)}
          </Select>
        </div>
        <div>
          <Label htmlFor="position-revise-date">{labels.effectiveDate}</Label>
          <Input id="position-revise-date" type="date" value={revisionDate} required disabled={busy} onChange={(event) => setRevisionDate(event.target.value)} />
        </div>
        <div>
          <Label htmlFor="position-revise-reason">{labels.reason}</Label>
          <Textarea id="position-revise-reason" value={revisionReason} required disabled={busy} onChange={(event) => setRevisionReason(event.target.value)} />
        </div>
        <Button type="submit" size="sm" disabled={busy || !revisionReason.trim()}>{labels.revise}</Button>
      </form>

      <h3 className="text-sm font-semibold">{labels.fund}</h3>
      {periods.length > 0 ? (
        <form className="space-y-2" onSubmit={(event) => {
          event.preventDefault()
          void submit({ action: 'fund', periodId, fundedFte: fundedFte.trim(), reason: fundingReason.trim() })
        }}>
          <div>
            <Label htmlFor="position-fund-period">{labels.period}</Label>
            <Select id="position-fund-period" value={periodId} disabled={busy} onChange={(event) => {
              setPeriodId(event.target.value)
              setFundedFte(periods.find((period) => period.value === event.target.value)?.fundedFte ?? '0.0000')
            }}>
              {periods.map((period) => <option key={period.value} value={period.value}>{period.label}</option>)}
            </Select>
          </div>
          <div>
            <Label htmlFor="position-fund-fte">{labels.fundedFte}</Label>
            <Input id="position-fund-fte" inputMode="decimal" value={fundedFte} required disabled={busy} onChange={(event) => setFundedFte(event.target.value)} />
          </div>
          <div>
            <Label htmlFor="position-fund-reason">{labels.reason}</Label>
            <Textarea id="position-fund-reason" value={fundingReason} required disabled={busy} onChange={(event) => setFundingReason(event.target.value)} />
          </div>
          <Button type="submit" size="sm" disabled={busy || !periodId || !fundingReason.trim()}>{labels.fund}</Button>
        </form>
      ) : <p className="text-sm text-slate-500">{labels.period}: —</p>}

      <h3 className="text-sm font-semibold">{labels.close}</h3>
      <form className="space-y-2" onSubmit={(event) => {
        event.preventDefault()
        void submit({ action: 'close', effectiveDate: closeDate, reason: closeReason.trim() })
      }}>
        <div>
          <Label htmlFor="position-close-date">{labels.effectiveDate}</Label>
          <Input id="position-close-date" type="date" value={closeDate} required disabled={busy} onChange={(event) => setCloseDate(event.target.value)} />
        </div>
        <div>
          <Label htmlFor="position-close-reason">{labels.reason}</Label>
          <Textarea id="position-close-reason" value={closeReason} required disabled={busy} onChange={(event) => setCloseReason(event.target.value)} />
        </div>
        <Button type="submit" size="sm" disabled={busy || !closeReason.trim()}>{labels.close}</Button>
      </form>
      {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {saved ? <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{saved}</p> : null}
    </section>
  )
}
