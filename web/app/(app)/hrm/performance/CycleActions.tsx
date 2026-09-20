'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Label } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import type { PerformancePageData } from './view'

type Calibration = NonNullable<PerformancePageData['detail']>['calibration']

/**
 * The calibration island in the cycle drawer: move to calibrating (with an
 * optional force reason recorded on each pending review), or close the
 * cycle. Closing shares nothing by itself. Refusals render as the error.
 */
export function CycleActions({ cycleId, calibration }: { cycleId: string; calibration: Calibration }) {
  const router = useRouter()
  const [forceReason, setForceReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/hrm/review-cycles/${cycleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, calibration.failed))
        setBusy(false)
        return
      }
      router.refresh()
    } catch {
      setError(calibration.failed)
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {calibration.gapNote ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">{calibration.gapNote}</p>
      ) : null}
      {calibration.canMove ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={busy} onClick={() => act({ action: 'to-calibrating' })}>
            {calibration.moveLabel}
          </Button>
        </div>
      ) : null}
      {calibration.canForce ? (
        <div className="space-y-2">
          <Label htmlFor="force-reason">{calibration.forceReasonLabel}</Label>
          <Input
            id="force-reason"
            value={forceReason}
            onChange={(e) => setForceReason(e.target.value)}
            placeholder={calibration.forceReasonPlaceholder}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy || forceReason.trim().length === 0}
            onClick={() => act({ action: 'to-calibrating', force: true, forceReason: forceReason.trim() })}
          >
            {calibration.forceLabel}
          </Button>
        </div>
      ) : null}
      {calibration.canClose ? (
        <Button type="button" variant="outline" disabled={busy} onClick={() => act({ action: 'close' })}>
          {calibration.closeLabel}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  )
}
