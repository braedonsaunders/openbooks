'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge, EmptyState } from '@openbooks/ui'
import { PagedTable } from '../../../../components/paged-table'
import { money } from '../../../../lib/format'

interface TaskRow {
  id: string
  code: string | null
  name: string
  status: string
  estimated_hours: string | null
  estimated_cost: string | null
}
interface TxnRow {
  id: string
  kind: string
  documentNumber: string
  documentDate: string
  partyName: string | null
  status: string
  amount: string | number
}

// document kind → the module flyout that opens it
const DOC_LINKS: Record<string, { base: string; param: string; labelKey: string }> = {
  bill: { base: '/ap', param: 'bill', labelKey: 'docKinds.bill' },
  vendor_bill: { base: '/ap', param: 'bill', labelKey: 'docKinds.bill' },
  customer_invoice: { base: '/ar', param: 'invoice', labelKey: 'docKinds.invoice' },
  invoice: { base: '/ar', param: 'invoice', labelKey: 'docKinds.invoice' },
  expense: { base: '/expenses', param: 'expense', labelKey: 'docKinds.expense' },
  expense_report: { base: '/expenses', param: 'expense', labelKey: 'docKinds.expense' },
  purchase_order: { base: '/purchase-orders', param: 'order', labelKey: 'docKinds.purchaseOrder' },
  sales_order: { base: '/sales-orders', param: 'order', labelKey: 'docKinds.salesOrder' },
  journal: { base: '/journal', param: 'entry', labelKey: 'docKinds.journal' },
  journal_entry: { base: '/journal', param: 'entry', labelKey: 'docKinds.journal' },
}
const DOC_STATUS_KEYS: Record<string, string> = {
  draft: 'draft', pending_approval: 'pendingApproval', approved: 'approved', rejected: 'rejected',
  posted: 'posted', paid: 'paid', partially_paid: 'partiallyPaid', open: 'open', closed: 'closed',
  voided: 'voided', reversed: 'reversed', cancelled: 'cancelled',
}

export function TransactionsTab({ tasks, transactions }: { tasks: TaskRow[]; transactions: TxnRow[] }) {
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const taskStatusLabel = (s: string) =>
    s === 'complete' ? t('taskStatus.complete') : s === 'open' || s === 'cancelled' ? tCommon(`status.${s}`) : s
  const docStatusLabel = (s: string) => (DOC_STATUS_KEYS[s] ? tCommon(`status.${DOC_STATUS_KEYS[s]}`) : s)

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cockpit.wbsTitle')}</h2>
        <PagedTable
          rows={tasks}
          rowKey={(r) => r.id}
          searchable
          empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('cockpit.noWbsTasks')}</p>}
          columns={[
            { key: 'code', header: t('labels.code'), cell: (r) => <span className="font-mono text-[13px]">{r.code}</span>, search: (r) => r.code ?? '' },
            { key: 'name', header: t('labels.task'), cell: (r) => <span className="font-medium">{r.name}</span>, search: (r) => r.name },
            { key: 'status', header: tCommon('labels.status'), cell: (r) => <Badge variant={r.status === 'complete' ? 'success' : r.status === 'cancelled' ? 'outline' : 'secondary'}>{taskStatusLabel(r.status)}</Badge> },
            { key: 'estHours', header: t('labels.estHours'), align: 'right', cell: (r) => (r.estimated_hours != null ? money(r.estimated_hours) : '—') },
            { key: 'estCost', header: t('labels.estCost'), align: 'right', cell: (r) => (r.estimated_cost != null ? money(r.estimated_cost) : '—') },
          ]}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cockpit.transactions')}</h2>
        <PagedTable
          rows={transactions}
          rowKey={(r) => r.id}
          searchable
          empty={<EmptyState title={t('cockpit.noTransactionsTitle')} description={t('cockpit.noTransactionsDescription')} />}
          columns={[
            { key: 'date', header: tCommon('labels.date'), cell: (r) => <span className="text-slate-500 dark:text-slate-400">{r.documentDate}</span> },
            { key: 'kind', header: t('labels.kind'), cell: (r) => <Badge variant="secondary">{DOC_LINKS[r.kind] ? t(DOC_LINKS[r.kind].labelKey) : r.kind.replace(/_/g, ' ')}</Badge> },
            {
              key: 'number', header: tCommon('labels.number'), search: (r) => r.documentNumber,
              cell: (r) => {
                const link = DOC_LINKS[r.kind]
                return link ? (
                  <Link href={`${link.base}?${link.param}=${r.id}`} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{r.documentNumber}</Link>
                ) : (
                  <span className="font-medium">{r.documentNumber}</span>
                )
              },
            },
            { key: 'party', header: tCommon('labels.party'), cell: (r) => <span className="text-slate-500 dark:text-slate-400">{r.partyName}</span>, search: (r) => r.partyName ?? '' },
            { key: 'status', header: tCommon('labels.status'), cell: (r) => <Badge variant="outline">{docStatusLabel(r.status)}</Badge> },
            { key: 'amount', header: tCommon('labels.amount'), align: 'right', cell: (r) => money(r.amount) },
          ]}
        />
      </section>
    </div>
  )
}
