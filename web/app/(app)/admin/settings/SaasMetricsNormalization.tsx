'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  FieldLabel,
  Input,
} from '@openbooks/ui'

type MonthState = {
  month: string
  state: 'legacy' | 'ready' | 'pending' | 'running' | 'failed' | 'refused'
  counts: { monthly: number; facts: number; cohorts: number }
  denominationVersion: string | null
  reportingCurrency: string | null
  request: { id: string; status: string } | null
  failure: string | null
  remedy: string | null
}

type ErrorBody = { error?: string; code?: string; remedy?: string }

/** Read the refusal body only after the status is known: a non-JSON error
 *  page must never replace the refusal the operator needs. */
async function readError(response: Response): Promise<ErrorBody> {
  try {
    return (await response.json()) as ErrorBody
  } catch {
    return {}
  }
}

/**
 * The normalization operator workflow, composed inside the existing Company
 * Settings SaaS Metrics card. Lists every month with its audited state and
 * row counts, files correction requests, and records distinct approvals —
 * all against the authenticated API, never a second settings source.
 */
export function SaasMetricsNormalization() {
  const t = useTranslations('admin.settings')
  const copy = (key: string) => t(`saasMetrics.normalization.${key}`)
  const [months, setMonths] = useState<MonthState[] | null>(null)
  const [problem, setProblem] = useState<ErrorBody | null>(null)
  const [month, setMonth] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch('/api/metrics/normalization')
    if (!res.ok) {
      const body = await readError(res)
      setProblem({ ...body, error: body.error ?? copy('loadFailed') })
      setMonths([])
      return
    }
    setProblem(null)
    setMonths((await res.json()) as MonthState[])
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function submitRequest() {
    setBusy(true)
    try {
      const res = await fetch('/api/metrics/normalization/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, reason, idempotencyKey: crypto.randomUUID() }),
      })
      if (!res.ok) {
        setProblem(await readError(res))
        return
      }
      setProblem(null)
      setReason('')
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function approve(requestId: string) {
    setBusy(true)
    try {
      const res = await fetch(`/api/metrics/normalization/requests/${requestId}/approve`, { method: 'POST' })
      if (!res.ok) {
        setProblem(await readError(res))
        return
      }
      setProblem(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 border-t border-slate-200 pt-4 dark:border-slate-700">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{copy('title')}</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400">{copy('description')}</p>
      </div>
      {problem?.error ? (
        <Alert>
          <AlertTitle>{problem.error}</AlertTitle>
          {problem.remedy ? <AlertDescription>{problem.remedy}</AlertDescription> : null}
        </Alert>
      ) : null}
      {months === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{copy('loadFailed')}</p>
      ) : months.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{copy('empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500 dark:text-slate-400">
              <th className="py-1 pr-3 font-medium">{copy('monthColumn')}</th>
              <th className="py-1 pr-3 font-medium">{copy('statusColumn')}</th>
              <th className="py-1 pr-3 font-medium">{copy('countsColumn')}</th>
              <th className="py-1 font-medium"><span className="sr-only">{copy('approveSubmit')}</span></th>
            </tr>
          </thead>
          <tbody>
            {months.map((entry) => {
              const pendingRequestId = entry.state === 'pending' ? entry.request?.id : undefined
              return (
              <tr key={entry.month} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-2 pr-3 text-slate-900 dark:text-slate-100">{entry.month}</td>
                <td className="py-2 pr-3">
                  <span className="text-slate-700 dark:text-slate-300">
                    {copy(`states.${entry.state}`)}
                  </span>
                  {entry.request ? (
                    <span className="block text-xs text-slate-500 dark:text-slate-400">{entry.request.id}</span>
                  ) : null}
                  {entry.failure ? (
                    <span className="block text-xs text-red-600 dark:text-red-400">
                      {copy('failureLabel')}: {entry.failure}
                    </span>
                  ) : null}
                  {entry.remedy ? (
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {copy('remedyLabel')}: {entry.remedy}
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-3 text-slate-700 dark:text-slate-300">
                  {entry.counts.monthly} / {entry.counts.facts} / {entry.counts.cohorts}
                </td>
                <td className="py-2">
                  {pendingRequestId ? (
                    <Button disabled={busy} onClick={() => void approve(pendingRequestId)}>
                      {copy('approveSubmit')}
                    </Button>
                  ) : null}
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{copy('requestTitle')}</h4>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <FieldLabel htmlFor="normalization-month">{copy('requestMonth')}</FieldLabel>
            <Input
              id="normalization-month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              placeholder={copy('requestMonthPlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="normalization-reason" help={copy('requestReasonHint')}>
              {copy('requestReason')}
            </FieldLabel>
            <Input
              id="normalization-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Button disabled={busy} onClick={() => void submitRequest()}>
            {copy('requestSubmit')}
          </Button>
        </div>
      </div>
    </div>
  )
}
