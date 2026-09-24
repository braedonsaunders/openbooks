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
import { readApiBulkFailures, readApiErrorMessage } from '../../../../lib/api-error'
import { CaptureUploadButton } from './CaptureUploadButton'

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

/**
 * The capture queue table.
 *
 * This one is a WIDGET rather than a `table` block, and the reason is worth
 * stating: it is not the shared app table. The native page owns row-selection
 * state, per-row checkboxes (materialized rows are unselectable), and three
 * bulk actions driven by that state — none of which the spec's table
 * vocabulary can name. The ViewSpec table block deliberately offers only the
 * two real table variants the app has; expressing this one would mean either
 * teaching the spec to carry client state or quietly restyling the page — so
 * it stays a component, and the spec places it (same treatment as
 * `AdminUsersTable`).
 *
 * Everything around it — the header, the search and filter row, the pager,
 * the review drawer — is ordinary spec.
 */
export function CaptureList({ rows, currentParams, canCreate, uploadDisabled, sort, dir }: { rows: CaptureListRow[]; currentParams: Record<string, string | string[] | undefined>; canCreate: boolean; uploadDisabled: boolean; sort: string; dir: 'asc' | 'desc' }) {
  const t = useTranslations('ap.capture')
  const locale = useLocale()
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const selectable = rows.filter((row) => row.status !== 'materialized')

  const [bulkResult, setBulkResult] = useState<{
    succeeded: number
    failures: Array<{ id: string; name: string; error: string }>
  } | null>(null)
  const names = new Map(rows.map((row) => [row.id, row.filename] as const))

  async function act(action: 'reprocess' | 'reject' | 'materialize') {
    if (!selected.size) return
    setBusy(true)
    setBulkResult(null)
    try {
      const response = await fetch('/api/ap-capture/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ids: [...selected] }),
      })
      // The status is checked before the body parses: a non-JSON 502 page
      // must toast the translated fallback, never a SyntaxError.
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('actionFailed')))
      const body = (await response.json()) as { results?: Array<{ id: string; ok: boolean }> }
      // A partial bulk result names its reasons per item instead of
      // collapsing them to counts: the operator can act only on the which
      // and the why. Failed rows stay selected for a one-click retry.
      const failed = readApiBulkFailures(body, t('actionFailed'))
      const succeeded = (body.results?.length ?? 0) - failed.length
      if (failed.length > 0) {
        setBulkResult({
          succeeded,
          failures: failed.map((item) => ({ ...item, name: names.get(item.id) ?? item.id })),
        })
        setSelected(new Set(failed.map((item) => item.id)))
        toast.error(t('bulkPartial', { succeeded, failed: failed.length }))
      } else {
        toast.success(t('bulkComplete', { succeeded, failed: 0 }))
        setSelected(new Set())
      }
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  // The empty queue names its setup route: creators who can upload get the
  // upload action inline; while capture is not operational the amber banner
  // above already carries the AI setup link; readers without creation access
  // hear the grant instead of an action they cannot take.
  if (!rows.length) {
    return (
      <EmptyState
        icon={<FileSearch />}
        title={t('emptyTitle')}
        description={canCreate ? t('emptyDescription') : t('emptyDescriptionNoGrant')}
        action={canCreate && !uploadDisabled ? <CaptureUploadButton /> : undefined}
      />
    )
  }
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
      {bulkResult && bulkResult.failures.length > 0 ? (
        <div role="alert" className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900/60 dark:bg-red-950/40">
          <p className="font-medium text-red-800 dark:text-red-200">
            {t('bulkPartial', { succeeded: bulkResult.succeeded, failed: bulkResult.failures.length })}
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-red-700 dark:text-red-300">
            {bulkResult.failures.map((item) => (
              <li key={item.id}>
                <span className="font-medium">{item.name}</span>
                {' — '}
                {item.error}
              </li>
            ))}
          </ul>
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
