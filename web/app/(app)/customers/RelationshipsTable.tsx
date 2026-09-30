'use client'

import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "@openbooks/ui"
import { useMoney } from '@/components/money-provider'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { cmp } from '@openbooks/engine/src/money/money.ts'
import { EntityDrawer } from '../analytics/_ui/EntityDrawer'
import type { CustomerExposureRow } from '../../../lib/module-home/customers'
import { InteractiveTableRow } from '@/components/interactive-table-row'

/**
 * Customers-home hero table — one click on any relationship opens the shared
 * entity reliability drawer (payment history, reliability score, open items
 * with in-place document drill). Same drawer the AR cockpit and cash flyout
 * use, so the drill feels identical everywhere.
 */
export function RelationshipsTable({ rows, crmEnabled = true }: { rows: CustomerExposureRow[]; crmEnabled?: boolean }) {
  const { money, moneyCompact } = useMoney()
  const t = useTranslations('customers')
  const [entity, setEntity] = useState<{ id: string; name: string } | null>(null)

  return (
    <>
      <SharedTable className="w-full text-sm">
        <SharedTableHeader className="sticky top-0 z-10 bg-white dark:bg-slate-900">
          <SharedTableRow className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <SharedTableHead className="px-4 py-2 text-left font-medium">{t('home.hero.customer')}</SharedTableHead>
            {crmEnabled ? <SharedTableHead className="px-3 py-2 text-center font-medium">{t('home.hero.openOpps')}</SharedTableHead> : null}
            <SharedTableHead className="px-3 py-2 text-center font-medium">{t('home.hero.openInvoices')}</SharedTableHead>
            <SharedTableHead className="px-3 py-2 text-right font-medium">{t('home.hero.oldestDue')}</SharedTableHead>
            <SharedTableHead className="px-3 py-2 text-right font-medium">{t('home.hero.overdue')}</SharedTableHead>
            <SharedTableHead className="px-4 py-2 text-right font-medium">{t('home.hero.open')}</SharedTableHead>
          </SharedTableRow>
        </SharedTableHeader>
        <SharedTableBody>
          {rows.map((r) => (
            <InteractiveTableRow
              key={r.partyId ?? r.name}
              onClick={r.partyId ? () => setEntity({ id: r.partyId!, name: r.name }) : undefined}
              className={`border-b border-slate-50 last:border-0 dark:border-slate-800/60 ${r.partyId ? 'cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50' : ''}`} noAnimate
            >
              <SharedTableCell className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-200">{r.name}</SharedTableCell>
              {crmEnabled ? (
              <SharedTableCell className="px-3 py-2.5 text-center">
                {r.openOpportunities > 0 ? (
                  <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 tabular-nums dark:bg-violet-950/50 dark:text-violet-300">
                    {r.openOpportunities}
                  </span>
                ) : (
                  <span className="text-slate-300 dark:text-slate-600">—</span>
                )}
              </SharedTableCell>
              ) : null}
              <SharedTableCell className="px-3 py-2.5 text-center text-xs tabular-nums text-slate-500 dark:text-slate-400">{r.openInvoices}</SharedTableCell>
              <SharedTableCell className="px-3 py-2.5 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{r.oldestDue ?? '—'}</SharedTableCell>
              <SharedTableCell className="px-3 py-2.5 text-right tabular-nums">
                {cmp(r.overdue, '0') > 0 ? (
                  <span className="text-red-600 dark:text-red-400">{moneyCompact(r.overdue)}</span>
                ) : (
                  <span className="text-slate-300 dark:text-slate-600">—</span>
                )}
              </SharedTableCell>
              <SharedTableCell className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">{money(r.open)}</SharedTableCell>
            </InteractiveTableRow>
          ))}
        </SharedTableBody>
      </SharedTable>
      {entity ? <EntityDrawer party={entity.id} name={entity.name} side="ar" onClose={() => setEntity(null)} /> : null}
    </>
  )
}
