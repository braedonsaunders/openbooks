'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Label } from '@openbooks/ui'

export interface ReviewHistoryEntry {
  status: string
  statusLabel: string
  at: string
  reason: string | null
}

export interface ReviewDrawerData {
  id: string
  providerLabel: string
  kindLabel: string
  statusLabel: string
  isPending: boolean
  amount: string
  providerEventId: string
  providerRef: string | null
  reason: string | null
  receiptNumber: string | null
  invoiceNumber: string | null
  history: ReviewHistoryEntry[]
  canDecide: boolean
  closeHref: string
  strings: {
    kindRow: string
    statusRow: string
    amountRow: string
    eventRow: string
    providerRefRow: string
    reasonGivenRow: string
    receiptRow: string
    invoiceRow: string
    historyTitle: string
    approveLabel: string
    rejectLabel: string
    reasonLabel: string
    reasonPlaceholder: string
    decidedNote: string
    approvedMessage: string
    rejectedMessage: string
    closeLabel: string
  }
}

/**
 * One parked refund or dispute with its consequence and its decision. The
 * drawer shows what approving will post (the amount, the linked receipt or
 * invoice it reopens) before the operator commits — accounting detail on
 * demand, never required to proceed — and rejecting moves nothing without a
 * named reason the audit keeps.
 */
export function PspDisputeReviewDrawer({ review }: { review: ReviewDrawerData }) {
  const router = useRouter()
  const { strings } = review
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function decide(action: 'approve' | 'reject') {
    setErr(null)
    setMsg(null)
    if (action === 'reject' && reason.trim().length < 5) {
      setErr(strings.reasonPlaceholder)
      return
    }
    setBusy(true)
    try {
      const response = await fetch('/api/psp/disputes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          action === 'approve'
            ? { action, disputeId: review.id }
            : { action, disputeId: review.id, reason: reason.trim() },
        ),
      })
      // The refusal names the state (already posted, already rejected);
      // parsing the body first would turn it into a JSON error about nothing.
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: unknown } | null
        const message = data?.error
        setErr(typeof message === 'string' && message ? message : strings.rejectedMessage)
        return
      }
      setMsg(action === 'approve' ? strings.approvedMessage : strings.rejectedMessage)
      setReason('')
      router.refresh()
    } catch {
      setErr(strings.rejectedMessage)
    } finally {
      setBusy(false)
    }
  }

  const rows: [string, string | null][] = [
    [strings.kindRow, review.kindLabel],
    [strings.statusRow, review.statusLabel],
    [strings.amountRow, review.amount],
    [strings.eventRow, review.providerEventId],
    [strings.providerRefRow, review.providerRef],
    [strings.reasonGivenRow, review.reason],
    [strings.receiptRow, review.receiptNumber],
    [strings.invoiceRow, review.invoiceNumber],
  ]

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white">{review.providerLabel}</h3>
      </div>
      {err && (
        <p role="alert" className="text-sm text-red-600">
          {err}
        </p>
      )}
      {msg && (
        <p aria-live="polite" className="text-sm text-teal-700 dark:text-teal-300">
          {msg}
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) =>
          value ? (
            <div key={label} className="contents">
              <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
              <dd className="tabular-nums">{value}</dd>
            </div>
          ) : null,
        )}
      </dl>
      {review.history.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400">{strings.historyTitle}</h4>
          <ul className="space-y-1 text-sm">
            {review.history.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="tabular-nums">
                {entry.statusLabel} · {entry.at}
                {entry.reason ? <span className="text-slate-500 dark:text-slate-400"> — {entry.reason}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {review.canDecide && review.isPending ? (
        <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
          <div>
            <Label htmlFor="psp-review-reason">{strings.reasonLabel}</Label>
            <Input
              id="psp-review-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={strings.reasonPlaceholder}
              maxLength={500}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void decide('approve')}>
              {strings.approveLabel}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || reason.trim().length < 5}
              onClick={() => void decide('reject')}
            >
              {strings.rejectLabel}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-slate-500 dark:text-slate-400">{strings.decidedNote}</p>
      )}
      <div>
        <Button size="sm" variant="ghost" onClick={() => router.push(review.closeHref)}>
          {strings.closeLabel}
        </Button>
      </div>
    </div>
  )
}
