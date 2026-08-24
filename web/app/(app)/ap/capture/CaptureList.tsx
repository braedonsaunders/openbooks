'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { FileSearch, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { mergeHref } from '../../../../lib/list-params'
import { SortTh } from '../../../../components/sortable-th'

export type CaptureListRow = {
  id: string
  status: string
  filename: string
  documentKind: string
  vendorName: string | null
  resolvedVendor: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  currency: string | null
  total: string | null
  overallConfidence: string | null
  validationIssues: Array<{ severity?: string }>
  documentId: string | null
  receivedAt: string
}

const VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'outline' | 'secondary'> = {
  ready: 'success', materialized: 'success', needs_review: 'warning', duplicate: 'warning', failed: 'destructive', extracting: 'secondary', queued: 'secondary', rejected: 'outline',
}

export function CaptureList({ rows, currentParams, canCreate, sort, dir }: { rows: CaptureListRow[]; currentParams: Record<string, string | string[] | undefined>; canCreate: boolean; sort: string; dir: 'asc' | 'desc' }) {
  const t = useTranslations('ap.capture')
  const locale = useLocale()
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const selectable = rows.filter((row) => row.status !== 'materialized')

  async function act(action: 'reprocess' | 'reject' | 'materialize') {
    if (!selected.size) return
    setBusy(true)
    try {
      const response = await fetch('/api/ap-capture/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ids: [...selected] }),
      })
      const body = (await response.json()) as { results?: Array<{ ok: boolean }> }
      if (!response.ok) throw new Error('action_failed')
      const succeeded = body.results?.filter((result) => result.ok).length ?? 0
      const failed = (body.results?.length ?? 0) - succeeded
      toast.success(t('bulkComplete', { succeeded, failed }))
      setSelected(new Set())
      router.refresh()
    } catch {
      toast.error(t('actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (!rows.length) return <EmptyState icon={<FileSearch />} title={t('emptyTitle')} description={t('emptyDescription')} />
  return (
    <div className="space-y-2">
      {canCreate ? (
        <div className="flex min-h-9 flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={selectable.length > 0 && selectable.every((row) => selected.has(row.id))}
              onChange={(event) => setSelected(event.target.checked ? new Set(selectable.map((row) => row.id)) : new Set())}
              className="h-4 w-4 rounded border-slate-300 text-teal-600"
            />
            {t('selected', { count: selected.size })}
          </label>
          {selected.size ? (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('reprocess')}>{busy ? <Loader2 size={13} className="animate-spin" /> : null}{t('reprocess')}</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('reject')}>{t('reject')}</Button>
              <Button size="sm" disabled={busy} onClick={() => void act('materialize')}>{t('createDrafts')}</Button>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
        <Table>
          <TableHeader><TableRow>
            {canCreate ? <TableHead className="w-10"><span className="sr-only">{t('select')}</span></TableHead> : null}
            <SortTh basePath="/ap/capture" currentParams={currentParams} column="filename" sort={sort} dir={dir}>{t('columns.document')}</SortTh><TableHead>{t('columns.vendor')}</TableHead>
            <TableHead>{t('columns.invoice')}</TableHead><TableHead>{t('columns.date')}</TableHead>
            <SortTh basePath="/ap/capture" currentParams={currentParams} column="total" sort={sort} dir={dir} align="right" className="text-right">{t('columns.total')}</SortTh><SortTh basePath="/ap/capture" currentParams={currentParams} column="status" sort={sort} dir={dir}>{t('columns.status')}</SortTh>
            <SortTh basePath="/ap/capture" currentParams={currentParams} column="received" sort={sort} dir={dir}>{t('columns.received')}</SortTh>
          </TableRow></TableHeader>
          <TableBody>{rows.map((row) => {
            const issues = Array.isArray(row.validationIssues) ? row.validationIssues.filter((value) => value.severity === 'blocking').length : 0
            return <TableRow key={row.id}>
              {canCreate ? <TableCell><input type="checkbox" disabled={row.status === 'materialized'} checked={selected.has(row.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(row.id); else next.delete(row.id); return next })} aria-label={t('selectDocument', { name: row.filename })} className="h-4 w-4 rounded border-slate-300 text-teal-600" /></TableCell> : null}
              <TableCell><Link href={(mergeHref('/ap/capture', currentParams, { capture: row.id }))} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{row.filename}</Link><div className="text-xs text-slate-400">{row.documentKind === 'vendor_credit' ? t('credit') : t('bill')}</div></TableCell>
              <TableCell>{row.resolvedVendor ?? row.vendorName ?? '—'}</TableCell>
              <TableCell>{row.invoiceNumber ?? '—'}</TableCell><TableCell>{row.invoiceDate ?? '—'}</TableCell>
              <TableCell className="text-right tabular-nums">{row.total ? `${row.currency ?? ''} ${row.total}`.trim() : '—'}</TableCell>
              <TableCell><div className="flex items-center gap-1.5"><Badge variant={VARIANT[row.status] ?? 'outline'}>{t(`status.${row.status}`)}</Badge>{issues ? <Badge variant="destructive">{issues}</Badge> : null}</div></TableCell>
              <TableCell className="whitespace-nowrap text-xs text-slate-500">{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(row.receivedAt))}</TableCell>
            </TableRow>
          })}</TableBody>
        </Table>
      </div>
    </div>
  )
}
