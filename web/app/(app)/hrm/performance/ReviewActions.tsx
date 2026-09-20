'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Label } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

/**
 * Review lifecycle actions beside the answer form: share with the subject,
 * acknowledge as the subject, calibrate with a rating and reason (HR), or
 * reopen with a reason (HR). Each action posts to PATCH
 * /api/hrm/reviews/[id]; refusals render as the error. Buttons render only
 * for transitions the loader resolved as available.
 */
export function ReviewActions({
  reviewId,
  cycleId,
  canShare,
  canAcknowledge,
  canCalibrate,
  canReopen,
  shareLabel,
  acknowledgeLabel,
  calibrateLabel,
  calibrateRatingLabel,
  reasonLabel,
  reopenLabel,
  failed,
}: {
  reviewId: string
  cycleId: string
  canShare: boolean
  canAcknowledge: boolean
  canCalibrate: boolean
  canReopen: boolean
  shareLabel: string
  acknowledgeLabel: string
  calibrateLabel: string
  calibrateRatingLabel: string
  reasonLabel: string
  reopenLabel: string
  failed: string
}) {
  const router = useRouter()
  const [rating, setRating] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/hrm/reviews/${reviewId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, failed))
        setBusy(false)
        return
      }
      router.push(`/hrm/performance?cycle=${cycleId}&review=${reviewId}`)
      router.refresh()
    } catch {
      setError(failed)
      setBusy(false)
    }
  }

  if (!canShare && !canAcknowledge && !canCalibrate && !canReopen) return null
  return (
    <div className="space-y-3">
      {canShare ? (
        <Button type="button" disabled={busy} onClick={() => act({ action: 'share' })}>
          {shareLabel}
        </Button>
      ) : null}
      {canAcknowledge ? (
        <Button type="button" disabled={busy} onClick={() => act({ action: 'acknowledge' })}>
          {acknowledgeLabel}
        </Button>
      ) : null}
      {canCalibrate ? (
        <div className="space-y-2">
          <div>
            <Label htmlFor="calibrate-rating">{calibrateRatingLabel}</Label>
            <Input id="calibrate-rating" value={rating} onChange={(e) => setRating(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="calibrate-reason">{reasonLabel}</Label>
            <Input id="calibrate-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={busy || rating.trim().length === 0 || reason.trim().length === 0}
            onClick={() => act({ action: 'calibrate', calibratedRating: rating.trim(), reason: reason.trim() })}
          >
            {calibrateLabel}
          </Button>
        </div>
      ) : null}
      {canReopen ? (
        <div className="space-y-2">
          <div>
            <Label htmlFor="reopen-reason">{reasonLabel}</Label>
            <Input id="reopen-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={busy || reason.trim().length === 0}
            onClick={() => act({ action: 'reopen', reason: reason.trim() })}
          >
            {reopenLabel}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  )
}
