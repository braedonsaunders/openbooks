'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, Button, Select } from '@openbooks/ui'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { sum } from '@openbooks/engine/src/money/money.ts'
import { PagedTable } from '@/components/paged-table'
import { KpiStrip } from '@/components/kpi-strip'
import { useReportOverlayOptional } from '@/components/navigation-provider'
import { transactionDrawerHref } from '@/lib/txn-links'
import { TxnLink } from '../reports/TxnLink'
import { useMoney } from '@/components/money-provider'

export interface CollectionsQueueRow {
  id: string; docId: string; docKind: string; docNumber: string | null; partyName: string;
  amount: string; dueDate: string | null; predictedDate: string; daysOverdue: number; method: string;
}
interface QueueData {
  rows: CollectionsQueueRow[]; asOf: string; overdue: string; expectedThisWeek: string; canCollect: boolean;
}

export function CollectionsQueue() {
  const t = useTranslations('ar.cockpit.worklist')
  const common = useTranslations('common')
  const { money } = useMoney()
  const router = useRouter()
  const overlay = useReportOverlayOptional()
  const pathname = usePathname() ?? '/collections'
  const params = useSearchParams()
  const [data, setData] = useState<QueueData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('overdue')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const load = useCallback(async () => {
    const result = await fetchAction<QueueData>('/api/collections/worklist')
    if (!result.ok) { setError(result.error.displayMessage(common('feedback.loadFailed'))); return }
    setData(result.data); setError(null)
    // A refresh must not retain a selection for an invoice no longer open.
    const ids = new Set(result.data.rows.map((row) => row.id))
    setSelected((current) => new Set([...current].filter((id) => ids.has(id))))
  }, [common])
  useEffect(() => { void Promise.resolve().then(load) }, [load])
  const rows = (data?.rows ?? []).filter((row) => status === 'overdue' ? row.daysOverdue > 0 : status === 'upcoming' ? row.daysOverdue <= 0 : true)
  const picked = (data?.rows ?? []).filter((row) => selected.has(row.id))
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next
  })
  return <div className="space-y-4">
    {error && <p role="alert" className="text-sm text-destructive">{error} <Button variant="outline" onClick={() => void load()}>{common('actions.retry')}</Button></p>}
    {data && <KpiStrip items={[
      { label: t('overdueToChase'), value: money(data.overdue), tone: 'bad' },
      { label: t('expectedThisWeek'), value: money(data.expectedThisWeek), tone: 'good' },
    ]} />}
    <PagedTable source="collections_worklist" rows={rows} rowKey={(row) => row.id} searchable
      empty={data ? t('empty') : error ? common('feedback.loadFailed') : common('feedback.loading')}
      toolbarAfter={<Select aria-label={t('status')} value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="all">{common('labels.all')}</option><option value="overdue">{t('overdueOnly')}</option><option value="upcoming">{t('upcoming')}</option>
      </Select>}
      selection={data?.canCollect ? { getId: (row) => row.id, selectedIds: selected, onToggle: toggle,
        onToggleAll: (ids) => setSelected((current) => {
          const next = new Set(current); const clear = ids.every((id) => next.has(id));
          ids.forEach((id) => { if (clear) next.delete(id); else next.add(id) }); return next
        }),
      } : undefined}
      onRowClick={(row) => {
        const href = transactionDrawerHref({ pathname: overlay?.pathname ?? pathname,
          query: overlay?.search ?? params.toString(), entryId: row.id, docKind: row.docKind, docId: row.docId })
        if (overlay) overlay.navigate(href); else router.push(href)
      }}
      columns={[
        { key: 'customer', header: t('customer'), search: (row) => row.partyName, cell: (row) => <span className="font-medium">{row.partyName}</span> },
        { key: 'invoice', header: common('labels.number'), search: (row) => row.docNumber ?? '', cell: (row) => <TxnLink entryId={row.id} docKind={row.docKind} docId={row.docId} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{row.docNumber ?? '—'}</TxnLink> },
        { key: 'due', header: t('due'), cell: (row) => row.dueDate ?? '—' },
        { key: 'status', header: t('status'), cell: (row) => row.daysOverdue > 0 ? <Badge variant="warning">{t('daysOverdue', { count: row.daysOverdue })}</Badge> : <Badge variant="secondary">{t('upcoming')}</Badge> },
        { key: 'prediction', header: t('prediction'), cell: (row) => row.predictedDate },
        { key: 'amount', header: t('amount'), align: 'right', cell: (row) => <span className="font-medium tabular-nums">{money(row.amount)}</span> },
      ]} />
    {data?.canCollect && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <span className="text-sm tabular-nums">{t('selected', { count: picked.length, amount: money(sum(picked.map((row) => row.amount))) })}</span>
      <Button disabled={!picked.length} onClick={() => router.push(`/receipts?view=runs&newRun=1&preselect=${picked.map((row) => row.docId).join(',')}`)}>{t('build')}</Button>
    </div>}
  </div>
}
