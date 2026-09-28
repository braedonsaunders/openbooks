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
import { PagedTable } from '@/components/paged-table'

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

async function readMonths(loadFailed: string, signal?: AbortSignal): Promise<{
  months: MonthState[]
  problem: ErrorBody | null
}> {
  try {
    const res = await fetch('/api/metrics/normalization', { signal })
    if (!res.ok) {
      const body = await readError(res)
      return { months: [], problem: { ...body, error: body.error ?? loadFailed } }
    }
    return { months: (await res.json()) as MonthState[], problem: null }
  } catch {
    return { months: [], problem: { error: loadFailed } }
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
  // One idempotency key per month+reason draft: an unchanged retry after a
  // committed or lost response replays stably, while a changed body rotates.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [keyFingerprint, setKeyFingerprint] = useState('')

  const load = useCallback(async () => {
    const result = await readMonths(t('saasMetrics.normalization.loadFailed'))
    setProblem(result.problem)
    setMonths(result.months)
  }, [t])

  useEffect(() => {
    const controller = new AbortController()
    void readMonths(t('saasMetrics.normalization.loadFailed'), controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setProblem(result.problem)
      setMonths(result.months)
    })
    return () => controller.abort()
  }, [t])

  async function submitRequest() {
    setBusy(true)
    try {
      const fingerprint = `${month}\n${reason}`
      let key = idempotencyKey
      if (fingerprint !== keyFingerprint) {
        key = crypto.randomUUID()
        setIdempotencyKey(key)
        setKeyFingerprint(fingerprint)
      }
      let res: Response
      try {
        res = await fetch('/api/metrics/normalization/requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ month, reason, idempotencyKey: key }),
        })
      } catch {
        setProblem({ error: copy('requestFailed') })
        return
      }
      if (!res.ok) {
        const body = await readError(res)
        setProblem({ ...body, error: body.error ?? copy('requestFailed') })
        return
      }
      setProblem(null)
      setReason('')
      // A conclusively created request consumes its draft: the next
      // submission starts from a fresh key.
      setIdempotencyKey(crypto.randomUUID())
      setKeyFingerprint('')
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function approve(requestId: string) {
    setBusy(true)
    try {
      let res: Response
      try {
        res = await fetch(`/api/metrics/normalization/requests/${requestId}/approve`, { method: 'POST' })
      } catch {
        setProblem({ error: copy('approveFailed') })
        return
      }
      if (!res.ok) {
        const body = await readError(res)
        setProblem({ ...body, error: body.error ?? copy('approveFailed') })
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
        <PagedTable<MonthState>
          rows={months}
          rowKey={(entry) => entry.month}
          pageSize={25}
          empty={<p className="text-sm text-slate-500 dark:text-slate-400">{copy('empty')}</p>}
          columns={[
            {
              key: 'month',
              header: copy('monthColumn'),
              cell: (entry) => <span className="text-slate-900 dark:text-slate-100">{entry.month}</span>,
            },
            {
              key: 'status',
              header: copy('statusColumn'),
              cell: (entry) => (
                <>
                  <span className="text-slate-700 dark:text-slate-300">{copy(`states.${entry.state}`)}</span>
                  {entry.state === 'ready' && entry.denominationVersion && entry.reportingCurrency ? (
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {copy('resultDenomination')}: {entry.denominationVersion} · {copy('resultCurrency')}: {entry.reportingCurrency}
                    </span>
                  ) : null}
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
                </>
              ),
            },
            {
              key: 'counts',
              header: copy('countsColumn'),
              cell: (entry) => (
                <span className="text-slate-700 dark:text-slate-300 tabular-nums">
                  {entry.counts.monthly} / {entry.counts.facts} / {entry.counts.cohorts}
                </span>
              ),
            },
            {
              key: 'approve',
              header: <span className="sr-only">{copy('approveSubmit')}</span>,
              cell: (entry) => {
                const requestId = entry.state === 'pending' ? entry.request?.id : undefined
                return requestId ? (
                  <Button disabled={busy} onClick={() => void approve(requestId)}>
                    {copy('approveSubmit')}
                  </Button>
                ) : null
              },
            },
          ]}
        />
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
