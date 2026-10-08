'use client'

import { PagedTable } from '../../../../components/paged-table'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import type { AiLedgerData } from '../../../../lib/hrm/ai-rails'

/** Native review declarations use the existing audited capability command; runtime authority remains in native actions. */
export function AiGovernanceSection({ ledger }: { ledger: AiLedgerData | null }) {
  const router = useRouter()
  const [reviewers, setReviewers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!ledger) return null

  const patch = async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      const res = await fetch('/api/admin/ai-capabilities', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, ledger.failedLabel))
        setBusy(false)
        return
      }
      setSaved(body.markReviewed ? ledger.reviewRecordedLabel : ledger.declarationSavedLabel)
      router.refresh()
    } catch {
      setError(ledger.failedLabel)
    } finally {
      setBusy(false)
    }
  }

  const sync = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      const res = await fetch('/api/admin/ai-capabilities', { method: 'POST' })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, ledger.failedLabel))
        setBusy(false)
        return
      }
      setSaved(ledger.registryRefreshedLabel)
      router.refresh()
    } catch {
      setError(ledger.failedLabel)
    } finally {
      setBusy(false)
    }
  }

  const capabilities = [...ledger.capabilities].sort((a, b) => a.key.localeCompare(b.key))
  return (
    <div className="space-y-4">
      {ledger.overdue.length > 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <p className="font-semibold">{ledger.overdueTitle}</p>
          <p>{ledger.overdueDescription}: {ledger.overdue.map((cap) => cap.name).join(', ')}</p>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {saved ? <p role="status" className="text-sm text-teal-700 dark:text-teal-300">{saved}</p> : null}
      <PagedTable source="assistant_action_limits" rows={capabilities} rowKey={(cap) => cap.key} searchable pageSize={10}
        empty={ledger.emptyLabel}
        toolbarAfter={<Button size="sm" variant="outline" disabled={busy} onClick={() => void sync()}>{ledger.syncLabel}</Button>}
        columns={[
          { key: 'capability', search: (cap) => `${cap.name} ${cap.purpose}`, header: ledger.capabilityColumns.capability, cell: (cap) => <div><span className="font-medium">{cap.name}</span><p className="text-xs text-slate-500">{cap.purpose}</p></div> },
          { key: 'autonomy', header: ledger.capabilityColumns.autonomy, cell: (cap) => <div className="space-y-1"><Select aria-label={`${ledger.capabilityColumns.autonomy}: ${cap.name}`} value={cap.autonomy} disabled={busy}
            onChange={(event) => void patch({ key: cap.key, autonomy: event.target.value })}>
            {cap.autonomyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select><p className="text-xs text-slate-500">{ledger.codeMaximumLabel}: {cap.codeMaximum}</p></div> },
          { key: 'reviewer', header: ledger.capabilityColumns.reviewer, cell: (cap) => <div className="flex items-center gap-1">
            <Input value={reviewers[cap.key] ?? cap.reviewerRole ?? ''} disabled={busy}
              onChange={(event) => setReviewers((previous) => ({ ...previous, [cap.key]: event.target.value }))}
              aria-label={`${ledger.capabilityColumns.reviewer}: ${cap.name}`} />
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void patch({ key: cap.key, reviewerRole: reviewers[cap.key] ?? cap.reviewerRole ?? '' })}>{ledger.saveLabel}</Button>
          </div> },
          { key: 'notice', header: ledger.capabilityColumns.notice, cell: (cap) => <span className="text-xs text-slate-500">{cap.noticeLabel}</span> },
          { key: 'reviewed', header: ledger.capabilityColumns.reviewed, cell: (cap) => <div className="space-y-1 text-xs"><span>{cap.reviewedLabel}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => void patch({ key: cap.key, markReviewed: true })}>{ledger.reviewLabel}</Button></div> },
          { key: 'enabled', header: ledger.capabilityColumns.enabled, cell: (cap) => cap.enabledLabel },
        ]} />
    </div>
  )
}
