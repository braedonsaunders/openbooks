'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowLeft, Play } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@openbooks/ui'

type Candidate = {
  documentId: string
  documentNumber: string
  kind: string
  effectiveDate: string
  periodId: string | null
  periodName: string | null
  blocked: boolean
  blockReason: string | null
}

type CommitResult = {
  assigned: { documentId: string; periodId: string }[]
  skipped: { documentId: string; reason: string }[]
  refused: { documentId: string; reason: string }[]
}

export function PostingPeriodsView({ bookId, runId }: { bookId: string | null; runId: string | null }) {
  const t = useTranslations('close')
  const [rows, setRows] = useState<Candidate[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CommitResult | null>(null)

  useEffect(() => {
    if (!bookId) return
    const url = `/api/close/posting-periods?bookId=${encodeURIComponent(bookId)}`
    let cancelled = false
    async function load() {
      const response = await fetch(url)
      if (!response.ok) {
        toast.error(t('postingPeriods.previewFailed'))
        return
      }
      const preview = (await response.json()) as { rows: Candidate[] }
      if (!cancelled) setRows(preview.rows)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [bookId, t])

  const assignable = (rows ?? []).filter((row) => !row.blocked)
  const blocked = (rows ?? []).filter((row) => row.blocked)

  async function commit() {
    setBusy(true)
    try {
      const response = await fetch('/api/close/posting-periods', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bookId,
          documentIds: assignable.map((row) => row.documentId),
        }),
      })
      const payload = (await response.json()) as (CommitResult & { error?: string })
      if (!response.ok) {
        toast.error(payload.error ?? t('postingPeriods.commitFailed'))
        return
      }
      setResult(payload)
      toast.success(t('postingPeriods.committed', { count: payload.assigned.length }))
      setRows((current) =>
        (current ?? []).filter(
          (row) => !payload.assigned.some((item) => item.documentId === row.documentId),
        ),
      )
    } catch {
      toast.error(t('postingPeriods.commitFailed'))
    } finally {
      setBusy(false)
    }
  }

  // No book context (bookmark, manual navigation): a neutral empty state with
  // a way back, never a throw into the route error boundary. The page is
  // normally opened from a close run, which always supplies ?book=.
  if (!bookId) {
    return (
      <div className="space-y-4">
        <PageHeader
          title={t('postingPeriods.title')}
          description={t('postingPeriods.description')}
        />
        <Card>
          <CardContent>
            <p className="text-sm text-slate-500">{t('postingPeriods.needsBook')}</p>
            <Link href="/close" className="mt-2 inline-flex items-center gap-1 text-sm">
              <ArrowLeft size={14} />
              {t('postingPeriods.backToClose')}
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('postingPeriods.title')}
        description={t('postingPeriods.description')}
      />
      {runId ? (
        <Link href={`/close?run=${encodeURIComponent(runId)}`} className="inline-flex items-center gap-1 text-sm">
          <ArrowLeft size={14} />
          {t('postingPeriods.backToClose')}
        </Link>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('postingPeriods.previewTitle', { count: rows?.length ?? 0 })}</CardTitle>
          <CardDescription>{t('postingPeriods.previewDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {rows === null ? (
            <p className="text-sm text-slate-500">{t('postingPeriods.loading')}</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-slate-500">{t('postingPeriods.empty')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1 pr-2">{t('postingPeriods.document')}</th>
                  <th className="py-1 pr-2">{t('postingPeriods.kind')}</th>
                  <th className="py-1 pr-2">{t('postingPeriods.effectiveDate')}</th>
                  <th className="py-1 pr-2">{t('postingPeriods.period')}</th>
                  <th className="py-1">{t('postingPeriods.status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.documentId} className="border-t">
                    <td className="py-1 pr-2 font-mono">{row.documentNumber}</td>
                    <td className="py-1 pr-2">{row.kind}</td>
                    <td className="py-1 pr-2">{row.effectiveDate}</td>
                    <td className="py-1 pr-2">{row.periodName ?? '—'}</td>
                    <td className="py-1">
                      {row.blocked ? (
                        <Badge variant="destructive">{row.blockReason}</Badge>
                      ) : (
                        <Badge variant="success">{t('postingPeriods.assignable')}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {assignable.length > 0 ? (
            <div className="mt-4">
              <Button onClick={commit} disabled={busy}>
                <Play size={14} />
                {t('postingPeriods.assign', { count: assignable.length })}
              </Button>
            </div>
          ) : null}
          {blocked.length > 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              {t('postingPeriods.blockedNote', { count: blocked.length })}
            </p>
          ) : null}
          {result && result.refused.length > 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              {t('postingPeriods.refusedNote', { count: result.refused.length })}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
