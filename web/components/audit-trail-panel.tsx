'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { History, Search } from 'lucide-react'
import { Badge, Button, EmptyState, Input, Select, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { dateTime } from '../lib/format'

type AuditRow = {
  id: string
  action: string
  changes: Record<string, unknown>
  at: string
  actor_name: string | null
}

type AuditResponse = {
  rows: AuditRow[]
  total: number
  page: number
  perPage: number
  actions: string[]
}

const ACTION_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'destructive'> = {
  insert: 'success',
  update: 'secondary',
  delete: 'destructive',
  post: 'success',
  void: 'warning',
  approve: 'success',
  reject: 'destructive',
}
const KNOWN_ACTIONS = new Set(['insert', 'update', 'delete', 'post', 'void', 'approve', 'reject'])

function changeCount(changes: Record<string, unknown>): number {
  if (changes.source === 'record_metadata') return 0
  if (changes.before && changes.after) return 1
  return Object.keys(changes).filter((key) => !['source', 'mode', 'reason'].includes(key)).length
}

export function AuditTrailPanel({ table, recordId }: { table: 'documents' | 'parties'; recordId: string }) {
  const t = useTranslations('common.auditTrail')
  const [q, setQ] = useState('')
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<AuditResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ table, id: recordId, page: String(page) })
      if (q.trim()) params.set('q', q.trim())
      if (action) params.set('action', action)
      setLoading(true)
      setError(false)
      fetch(`/api/audit/record?${params}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error('load failed')
          setData(await response.json() as AuditResponse)
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === 'AbortError') return
          setError(true)
        })
        .finally(() => setLoading(false))
    }, q ? 200 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [action, page, q, recordId, reloadKey, table])

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.perPage ?? 15)))
  const actionLabel = (value: string) => KNOWN_ACTIONS.has(value)
    ? t(`actions.${value}` as never)
    : value.replaceAll('_', ' ')

  return (
    <section className="space-y-3 p-1">
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" size={15} />
          <Input
            value={q}
            onChange={(event) => { setQ(event.target.value); setPage(1) }}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
          />
        </div>
        <Select value={action} onChange={(event) => { setAction(event.target.value); setPage(1) }} className="w-auto min-w-40" aria-label={t('actionFilter')}>
          <option value="">{t('allActions')}</option>
          {(data?.actions ?? []).map((value) => <option key={value} value={value}>{actionLabel(value)}</option>)}
        </Select>
      </div>

      {error ? (
        <EmptyState
          icon={<History />}
          title={t('loadFailedTitle')}
          description={t('loadFailedDescription')}
          action={<Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>{t('retry')}</Button>}
        />
      ) : loading && !data ? (
        <div className="space-y-2">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-12 w-full" />)}</div>
      ) : data?.rows.length ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('when')}</TableHead>
                <TableHead>{t('actor')}</TableHead>
                <TableHead>{t('action')}</TableHead>
                <TableHead>{t('changes')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((row) => {
                const count = changeCount(row.changes)
                return (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-xs">{dateTime(row.at)}</TableCell>
                    <TableCell>{row.actor_name ?? <span className="text-slate-400">{t('systemActor')}</span>}</TableCell>
                    <TableCell><Badge variant={ACTION_VARIANT[row.action] ?? 'secondary'}>{actionLabel(row.action)}</Badge></TableCell>
                    <TableCell className="max-w-sm">
                      {row.changes.source === 'record_metadata' ? (
                        <span className="text-sm text-slate-500 dark:text-slate-400">{t('metadata')}</span>
                      ) : (
                        <details>
                          <summary className="cursor-pointer text-sm text-teal-700 dark:text-teal-300">
                            {count > 0 ? t('changeCount', { count }) : t('viewChanges')}
                          </summary>
                          <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-100 p-2 font-mono text-[11px] whitespace-pre-wrap text-slate-600 dark:bg-slate-900 dark:text-slate-300">
                            {JSON.stringify(row.changes, null, 2)}
                          </pre>
                        </details>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-slate-500 dark:text-slate-400">{t('pageStatus', { page: data.page, pages, total: data.total })}</span>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>{t('previous')}</Button>
              <Button variant="outline" size="sm" disabled={page >= pages || loading} onClick={() => setPage((value) => Math.min(pages, value + 1))}>{t('next')}</Button>
            </div>
          </div>
        </>
      ) : (
        <EmptyState icon={<History />} title={t('emptyTitle')} description={t('emptyDescription')} />
      )}
    </section>
  )
}
