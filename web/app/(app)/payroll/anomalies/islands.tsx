'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, UrlDrawer } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { useBusinessToday } from '../../../../components/business-date-provider'
import type { AnomalyChecksData } from '../../../../lib/hrm/ai-rails'

/**
 * Payroll checks client islands (HR-21). Every string arrives
 * loader-resolved as props — no ids or Authz cross into the client.
 * Every API refusal renders with its message intact: res.ok is checked
 * before parsing, failures render inline, and nothing is swallowed.
 */

/** Run the deterministic scan for the current filter period. */
export function AnomalyScanButton({
  currentParams,
  scanLabel,
  scanBusyLabel,
  scanFailedLabel,
}: {
  currentParams: Record<string, string>
  scanLabel: string
  scanBusyLabel: string
  scanFailedLabel: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  // Both scan bounds default to the org's business day from the server — a
  // local `from` paired with a UTC `to` could invert the range in the
  // evening for the Americas.
  const today = useBusinessToday()
  const scan = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      const from = currentParams.from ?? `${today.slice(0, 7)}-01`
      const to = currentParams.to ?? today
      const res = await fetch('/api/payroll/anomalies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'scan', periodFrom: from, periodTo: to }),
      })
      if (!res.ok) {
        setStatus(await readApiErrorMessage(res, scanFailedLabel))
        return
      }
      router.refresh()
    } catch {
      setStatus(scanFailedLabel)
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button size="sm" disabled={busy} onClick={scan}>
        {busy ? scanBusyLabel : scanLabel}
      </Button>
      {status ? <span className="text-xs text-red-600 dark:text-red-400">{status}</span> : null}
    </span>
  )
}

type TransitionLabels = NonNullable<AnomalyChecksData['dialogFlag']>['transitionLabels']

/** Acknowledge, resolve, or mark false-positive with the audit reason. */
export function AnomalyTransitionForm({
  flagId,
  labels,
}: {
  flagId: string
  labels: TransitionLabels
}) {
  const router = useRouter()
  const [to, setTo] = useState<'acknowledged' | 'resolved' | 'false_positive'>('acknowledged')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      const res = await fetch(`/api/payroll/anomalies/${flagId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, reason }),
      })
      if (!res.ok) {
        setStatus(await readApiErrorMessage(res, labels.failedLabel))
        return
      }
      router.refresh()
    } catch {
      setStatus(labels.failedLabel)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {(['acknowledged', 'resolved', 'false_positive'] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={to === value ? undefined : 'outline'}
            disabled={busy}
            onClick={() => setTo(value)}
          >
            {value === 'acknowledged' ? labels.acknowledge : value === 'resolved' ? labels.resolve : labels.falsePositive}
          </Button>
        ))}
      </div>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">{labels.reasonLabel}</span>
        <textarea
          className="w-full rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
          rows={2}
          value={reason}
          placeholder={labels.reasonPlaceholder}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <Button size="sm" disabled={busy || reason.trim().length === 0} onClick={submit}>
        {labels.submitLabel}
      </Button>
      {status ? <p className="text-xs text-red-600 dark:text-red-400">{status}</p> : null}
    </div>
  )
}

/** Flag drawer: the explanation, the numbers, the linked records, actions. */
export function AnomalyDrawer({
  flag,
  closeHref,
}: {
  flag: NonNullable<AnomalyChecksData['dialogFlag']>
  closeHref: string
}) {
  // Every fact sits under its own heading: the severity value under
  // Severity, the status value under Status — never the kind under one and
  // the employment under the other.
  const facts: Array<[term: string, value: string]> = [
    [flag.severityTerm, flag.severityLabel],
    [flag.kindTerm, flag.kindLabel],
    [flag.employmentTerm, flag.employmentLabel],
    [flag.statusTerm, flag.statusLabel],
  ]
  return (
    <UrlDrawer open closeHref={closeHref} title={`${flag.kindLabel} · ${flag.periodLabel}`}>
      <div className="space-y-3">
        <p className="text-sm text-slate-700 dark:text-slate-200">{flag.explanation}</p>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          {facts.map(([term, value]) => (
            <div key={term}>
              <dt className="text-xs text-slate-500 dark:text-slate-400">{term}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        {flag.reason ? <p className="text-xs text-slate-500 dark:text-slate-400">{flag.reason}</p> : null}
        <AnomalyTransitionForm flagId={flag.id} labels={flag.transitionLabels} />
      </div>
    </UrlDrawer>
  )
}
