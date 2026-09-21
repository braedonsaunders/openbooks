'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import type { AiLedgerData } from '../../../../lib/hrm/ai-rails'

const AUTONOMIES = ['read_only', 'draft', 'propose', 'act_with_confirmation'] as const

/**
 * HR-21 AI governance ledger section on /admin/ai. Capabilities table
 * (autonomy select down-only, reviewer edit, review stamp, enabled
 * toggle, sync-from-registry) and the decisions log with
 * capability filter chips and CSV export. Every mutation goes through
 * the existing /api/admin/ai-* routes with their setup-grant gates and
 * refusals rendered inline. Renders nothing without the setup grant —
 * the loader passes null and the providers card stands alone.
 */
export function AiGovernanceSection({ ledger }: { ledger: AiLedgerData | null }) {
  const router = useRouter()
  const [reviewers, setReviewers] = useState<Record<string, string>>({})
  const [capFilter, setCapFilter] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!ledger) return null

  const patch = async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
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
    try {
      const res = await fetch('/api/admin/ai-capabilities', { method: 'POST' })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, ledger.failedLabel))
        setBusy(false)
        return
      }
      router.refresh()
    } catch {
      setError(ledger.failedLabel)
    } finally {
      setBusy(false)
    }
  }

  const capabilities = [...ledger.capabilities].sort((a, b) => a.key.localeCompare(b.key))
  const capKeys = [...new Set(ledger.decisions.map((d) => d.capabilityKey))].sort()
  const decisions = capFilter ? ledger.decisions.filter((d) => d.capabilityKey === capFilter) : ledger.decisions

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{ledger.title}</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{ledger.description}</p>
      </div>
      {ledger.overdue.length > 0 ? (
        <div className="rounded-xl border border-amber-200/80 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
          <p className="font-semibold">{ledger.overdueTitle}</p>
          <p className="mt-1">
            {ledger.overdueDescription}: {ledger.overdue.map((c) => c.key).join(', ')}
          </p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{ledger.capabilitiesTitle}</h3>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void sync()}>
            {ledger.syncLabel}
          </Button>
        </div>
        <div className="mt-2 overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <th className="px-3 py-2">{ledger.capabilityColumns.capability}</th>
                <th className="px-3 py-2">{ledger.capabilityColumns.autonomy}</th>
                <th className="px-3 py-2">{ledger.capabilityColumns.reviewer}</th>
                <th className="px-3 py-2">{ledger.capabilityColumns.notice}</th>
                <th className="px-3 py-2">{ledger.capabilityColumns.reviewed}</th>
                <th className="px-3 py-2">{ledger.capabilityColumns.enabled}</th>
              </tr>
            </thead>
            <tbody>
              {capabilities.map((cap) => (
                <tr key={cap.key} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-3 py-2">
                    <span className="font-medium">{cap.name}</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">{cap.purpose}</span>
                  </td>
                  <td className="px-3 py-2">
                    <Select
                      value={cap.autonomy}
                      disabled={busy}
                      onChange={(e) => void patch({ key: cap.key, autonomy: e.target.value })}
                    >
                      {AUTONOMIES.map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <Input
                        value={reviewers[cap.key] ?? cap.reviewerRole ?? ''}
                        disabled={busy}
                        onChange={(e) => setReviewers((prev) => ({ ...prev, [cap.key]: e.target.value }))}
                        aria-label={ledger.capabilityColumns.reviewer}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void patch({ key: cap.key, reviewerRole: reviewers[cap.key] ?? cap.reviewerRole ?? '' })
                        }
                      >
                        {ledger.saveLabel}
                      </Button>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{cap.noticeLabel}</td>
                  <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                    {cap.reviewedLabel}
                    <span className="block">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void patch({ key: cap.key, markReviewed: true })}>
                        {ledger.reviewLabel}
                      </Button>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {cap.enabledLabel}
                    <span className="block">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void patch({ key: cap.key, enabled: !cap.enabled })}
                      >
                        {cap.enabled ? ledger.disabledLabel : cap.enabledLabel}
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{ledger.decisionsTitle}</h3>
          <a
            href={`/api/admin/ai-decisions?format=csv${capFilter ? `&capabilityKey=${encodeURIComponent(capFilter)}` : ''}`}
            className="text-sm font-medium text-teal-700 dark:text-teal-300"
          >
            {ledger.exportLabel}
          </a>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button size="sm" variant={capFilter === '' ? undefined : 'outline'} disabled={busy} onClick={() => setCapFilter('')}>
            {ledger.allLabel}
          </Button>
          {capKeys.map((key) => (
            <Button
              key={key}
              size="sm"
              variant={capFilter === key ? undefined : 'outline'}
              disabled={busy}
              onClick={() => setCapFilter(key)}
            >
              {key}
            </Button>
          ))}
        </div>
        <div className="mt-2 overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <th className="px-3 py-2">{ledger.decisionColumns.when}</th>
                <th className="px-3 py-2">{ledger.decisionColumns.capability}</th>
                <th className="px-3 py-2">{ledger.decisionColumns.summary}</th>
                <th className="px-3 py-2">{ledger.decisionColumns.outcome}</th>
                <th className="px-3 py-2">{ledger.decisionColumns.reviewer}</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d) => (
                <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{d.recordedAt.slice(0, 16).replace('T', ' ')}</td>
                  <td className="px-3 py-2">{d.capabilityKey}</td>
                  <td className="px-3 py-2">{d.outputSummary}</td>
                  <td className="px-3 py-2">{d.outcome}</td>
                  <td className="px-3 py-2">{d.humanReviewer ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
