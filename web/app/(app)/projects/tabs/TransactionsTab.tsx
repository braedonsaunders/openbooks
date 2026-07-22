'use client'

import { useMoney } from '@/components/money-provider'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge, EmptyState } from '@openbooks/ui'
import { PagedTable } from '../../../../components/paged-table'
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
  expense: { base: '/expenses/reports', param: 'expense', labelKey: 'docKinds.expense' },
  expense_report: { base: '/expenses/reports', param: 'expense', labelKey: 'docKinds.expense' },
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

export function TransactionsTab({ transactions }: { transactions: TxnRow[] }) {
  const { money } = useMoney()
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const docStatusLabel = (s: string) => (DOC_STATUS_KEYS[s] ? tCommon(`status.${DOC_STATUS_KEYS[s]}`) : s)

  return (
    <div className="space-y-2">
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
    </div>
  )
}
