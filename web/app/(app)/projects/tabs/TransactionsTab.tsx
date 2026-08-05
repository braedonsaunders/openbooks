'use client'

import { useMoney } from '@/components/money-provider'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge, EmptyState, Select } from '@openbooks/ui'
import { PagedTable } from '../../../../components/paged-table'
import { DocTypeBadge, docTypeMeta } from '../../../../components/doc-type-badge'
import {
  ChargesSection,
  type ChargeEquipmentOption,
  type ChargeItemOption,
  type ChargeRow,
} from './ChargesSection'
interface TxnRow {
  id: string
  kind: string
  documentNumber: string
  documentDate: string
  partyName: string | null
  status: string
  amount: string | number
}

const DOC_STATUS_KEYS: Record<string, string> = {
  draft: 'draft', pending_approval: 'pendingApproval', approved: 'approved', rejected: 'rejected',
  posted: 'posted', paid: 'paid', partially_paid: 'partiallyPaid', open: 'open', closed: 'closed',
  voided: 'voided', reversed: 'reversed', cancelled: 'cancelled',
}

export function TransactionsTab({
  projectId,
  transactions,
  charges,
  items,
  equipment,
  absorption,
  chargeFormOpen,
  onChargeFormOpenChange,
}: {
  projectId: string
  transactions: TxnRow[]
  charges: ChargeRow[]
  items: ChargeItemOption[]
  equipment: ChargeEquipmentOption[]
  absorption: { recovered: string; billValue: string }
  chargeFormOpen: boolean
  onChargeFormOpenChange: (open: boolean) => void
}) {
  const { money } = useMoney()
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const pathname = usePathname() ?? '/projects'
  const searchParams = useSearchParams()
  const [kind, setKind] = useState('')
  const docStatusLabel = (s: string) => (DOC_STATUS_KEYS[s] ? tCommon(`status.${DOC_STATUS_KEYS[s]}`) : s)
  const kindLabel = (value: string) => {
    const key = `transactionTypes.${docTypeMeta(value).labelKey}` as never
    return tCommon.has(key) ? tCommon(key) : value.replace(/_/g, ' ')
  }
  const kinds = [...new Set(transactions.map((row) => row.kind))]
    .sort((a, b) => kindLabel(a).localeCompare(kindLabel(b)))
  const visibleTransactions = kind ? transactions.filter((row) => row.kind === kind) : transactions
  const transactionHref = (row: TxnRow) => {
    const next = new URLSearchParams(searchParams.toString())
    next.set('projectTab', 'transactions')
    next.delete('projectTxn')
    next.delete('projectTxnKind')
    next.delete('drawerReturn')
    const returnHref = `${pathname}?${next.toString()}`
    next.set('projectTxn', row.id)
    next.set('projectTxnKind', row.kind)
    next.set('drawerReturn', returnHref)
    return `${pathname}?${next.toString()}`
  }

  return (
    <div className="space-y-6">
      <ChargesSection
        projectId={projectId}
        charges={charges}
        items={items}
        equipment={equipment}
        absorption={absorption}
        formOpen={chargeFormOpen}
        onFormOpenChange={onChargeFormOpenChange}
        showKpis={false}
        showList={false}
      />
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cockpit.transactions')}</h2>
      <PagedTable
        rows={visibleTransactions}
        rowKey={(r) => r.id}
        searchable
        toolbarAfter={(
          <Select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="w-auto min-w-40"
            aria-label={tCommon('labels.type')}
          >
            <option value="">{t('cockpit.allTransactionTypes')}</option>
            {kinds.map((value) => (
              <option key={value} value={value}>
                {kindLabel(value)}
              </option>
            ))}
          </Select>
        )}
        empty={<EmptyState title={t('cockpit.noTransactionsTitle')} description={t('cockpit.noTransactionsDescription')} />}
        columns={[
            { key: 'date', header: tCommon('labels.date'), cell: (r) => <span className="text-slate-500 dark:text-slate-400">{r.documentDate}</span> },
            { key: 'kind', header: t('labels.kind'), cell: (r) => <DocTypeBadge kind={r.kind} full /> },
            {
              key: 'number', header: tCommon('labels.number'), search: (r) => r.documentNumber,
              cell: (r) => {
                return (
                  <Link href={transactionHref(r) as never} className="font-mono text-[13px] font-semibold text-teal-700 hover:underline dark:text-teal-300">
                    {r.documentNumber}
                  </Link>
                )
              },
            },
            { key: 'party', header: tCommon('labels.party'), cell: (r) => <span className="text-slate-500 dark:text-slate-400">{r.partyName}</span>, search: (r) => r.partyName ?? '' },
            { key: 'status', header: tCommon('labels.status'), cell: (r) => <Badge variant="outline">{docStatusLabel(r.status)}</Badge> },
            { key: 'amount', header: tCommon('labels.amount'), align: 'right', cell: (r) => money(r.amount) },
        ]}
      />
      </div>
    </div>
  )
}
