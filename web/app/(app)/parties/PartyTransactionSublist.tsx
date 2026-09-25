'use client'

/** Split from PartyDrawer.tsx (ARCH-FILE-SPLIT; pure moves only). */
import { SublistHeading, SublistEmpty } from './PartySummary'
import { useMoney } from '@/components/money-provider'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useViewerFormat } from '@/lib/viewer-format'
import { FileText, Search } from 'lucide-react'
import { toast } from 'sonner'
import { readApiErrorMessage } from '@/lib/api-error'
import { Badge, Button, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { DocTypeBadge, docTypeMeta } from '../../../components/doc-type-badge'

interface TransactionRow {
  id: string
  kind: string
  document_number: string
  reference_number: string | null
  document_date: string
  due_date: string | null
  status: string
  currency: string
  total: string
  open_balance: string | null
  memo: string | null
}

interface TransactionResponse {
  rows: TransactionRow[]
  total: number
  page: number
  perPage: number
  kinds: string[]
  statuses: string[]
}

const STATUS_KEYS: Record<string, string> = {
  draft: 'draft', pending_approval: 'pendingApproval', approved: 'approved', rejected: 'rejected',
  posted: 'posted', paid: 'paid', partially_paid: 'partiallyPaid', voided: 'voided',
  reversed: 'reversed', cancelled: 'cancelled',
}

function transactionTarget(row: TransactionRow): { path: string; param: string } {
  if (row.kind === 'vendor_bill' || row.kind === 'vendor_credit') return { path: '/ap', param: 'doc' }
  if (row.kind === 'customer_invoice' || row.kind === 'customer_credit') return { path: '/ar', param: 'doc' }
  if (row.kind === 'vendor_payment') return { path: '/payments', param: 'payment' }
  if (row.kind === 'customer_payment') return { path: '/receipts', param: 'payment' }
  if (row.kind === 'purchase_order') return { path: '/purchase-orders', param: 'order' }
  if (row.kind === 'sales_order') return { path: '/sales-orders', param: 'order' }
  if (row.kind === 'quote') return { path: '/estimates', param: 'estimate' }
  if (row.kind === 'expense_report') return { path: '/expenses/reports', param: 'expense' }
  if (row.kind === 'journal') return { path: '/journal', param: 'entry' }
  return { path: '/banking/transactions', param: 'doc' }
}

/** Exported for the refusal-path regression test: the drawer mounts it by tab. */
export function TransactionSublist({ partyId, role }: { partyId: string; role?: 'customer' | 'vendor' | 'employee' }) {
  const { date } = useViewerFormat()
  const { money } = useMoney()
  const t = useTranslations('parties.drawer')
  const tc = useTranslations('common')
  const pathname = usePathname() ?? '/parties'
  const currentSearchParams = useSearchParams()
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ key: string; value: TransactionResponse } | null>(null)
  const [loading, setLoading] = useState(true)
  const requestKey = JSON.stringify([partyId, q.trim(), kind, status, page])
  const visibleData = data?.key === requestKey ? data.value : null

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      const params = new URLSearchParams({ page: String(page) })
      if (q.trim()) params.set('q', q.trim())
      if (kind) params.set('kind', kind)
      if (status) params.set('status', status)
      fetch(`/api/parties/${partyId}/transactions?${params}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(await readApiErrorMessage(response, tc('feedback.loadFailed')))
          const payload = (await response.json()) as TransactionResponse
          if (!controller.signal.aborted) setData({ key: requestKey, value: payload })
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === 'AbortError') return
          toast.error(error instanceof Error ? error.message : tc('feedback.loadFailed'))
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, q ? 200 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [kind, page, partyId, q, requestKey, status, tc])

  const pages = Math.max(1, Math.ceil((visibleData?.total ?? 0) / (visibleData?.perPage ?? 15)))
  const statusLabel = (value: string) => {
    const key = STATUS_KEYS[value]
    return key ? tc(`status.${key}` as never) : value.replace(/_/g, ' ')
  }
  const transactionHref = (row: TransactionRow) => {
    const returnParams = new URLSearchParams(currentSearchParams.toString())
    if (returnParams.has('party')) {
      returnParams.set('partyTab', 'transactions')
      returnParams.set('partyTxn', row.id)
      returnParams.set('partyTxnKind', row.kind)
      returnParams.delete('drawerReturn')
      returnParams.delete('relatedParty')
      returnParams.delete('relatedPartyRole')
      returnParams.delete('relatedPartyTab')
      return `${pathname}?${returnParams.toString()}`
    }

    if (returnParams.has('relatedParty')) {
      returnParams.set('relatedPartyTab', 'transactions')
      returnParams.set('partyTxn', row.id)
      returnParams.set('partyTxnKind', row.kind)
      returnParams.delete('drawerReturn')
      return `${pathname}?${returnParams.toString()}`
    }

    // Defensive fallback for a PartyDrawer mounted outside either supported
    // URL host. Normal vendor/customer flows never leave their current page.
    const returnQuery = returnParams.toString()
    const returnHref = returnQuery ? `${pathname}?${returnQuery}` : pathname
    const target = transactionTarget(row)
    const params = new URLSearchParams({
      [target.param]: row.id,
      relatedParty: partyId,
      relatedPartyTab: 'transactions',
      drawerReturn: returnHref,
    })
    if (role) params.set('relatedPartyRole', role)
    return `${target.path}?${params.toString()}`
  }
  return (
    <section className="space-y-3">
      <SublistHeading title={t('transactionsHeading')} description={t('transactionsDescription')} icon={<FileText size={16} />} />
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" size={15} />
          <Input value={q} onChange={(event) => { setQ(event.target.value); setPage(1) }} placeholder={t('transactionSearch')} className="pl-8" />
        </div>
        <Select value={kind} onChange={(event) => { setKind(event.target.value); setPage(1) }} className="w-auto min-w-40" aria-label={tc('labels.type')}>
          <option value="">{t('allTypes')}</option>
          {(visibleData?.kinds ?? []).map((value) => {
            const meta = docTypeMeta(value)
            return <option key={value} value={value}>{tc(`transactionTypes.${meta.labelKey}` as never)}</option>
          })}
        </Select>
        <Select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1) }} className="w-auto min-w-40" aria-label={tc('labels.status')}>
          <option value="">{t('allStatuses')}</option>
          {(visibleData?.statuses ?? []).map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}
        </Select>
      </div>
      {loading && !visibleData ? (
        <div className="h-48 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
      ) : !visibleData?.rows.length ? (
        <SublistEmpty icon={<FileText size={22} />} text={t('noTransactions')} />
      ) : (
        <>
          <Table>
            <TableHeader><TableRow>
              <TableHead>{tc('labels.number')}</TableHead><TableHead>{tc('labels.date')}</TableHead>
              <TableHead>{tc('labels.reference')}</TableHead><TableHead>{tc('labels.status')}</TableHead>
              <TableHead className="text-right">{tc('labels.total')}</TableHead><TableHead className="text-right">{tc('labels.openBalance')}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {visibleData.rows.map((row) => (
                <TableRow key={row.id} className={loading ? 'opacity-60' : undefined}>
                  <TableCell><div className="flex items-center gap-2"><DocTypeBadge kind={row.kind} /><Link href={transactionHref(row) as never} className="font-mono text-[13px] font-semibold text-teal-700 hover:underline dark:text-teal-300">{row.document_number}</Link></div></TableCell>
                  <TableCell>{date(new Date(`${row.document_date}T12:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' })}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{row.reference_number || '—'}</TableCell>
                  <TableCell><Badge variant={row.status === 'posted' ? 'success' : row.status === 'pending_approval' ? 'warning' : 'secondary'}>{statusLabel(row.status)}</Badge></TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.total, { currency: row.currency })}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.open_balance == null ? '—' : money(row.open_balance, { currency: row.currency })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-slate-500 dark:text-slate-400">{t('transactionCount', { count: visibleData.total })}</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}>{tc('actions.previous')}</Button>
              <span className="text-xs tabular-nums text-slate-500">{page} / {pages}</span>
              <Button variant="outline" size="sm" disabled={page >= pages || loading} onClick={() => setPage((value) => value + 1)}>{tc('actions.next')}</Button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
