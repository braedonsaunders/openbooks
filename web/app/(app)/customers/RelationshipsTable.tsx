'use client'

import { useMoney } from '@/components/money-provider'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { EntityDrawer } from '../analytics/_ui/EntityDrawer'
import type { CustomerExposureRow } from '../../../lib/module-home/customers'

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
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
          <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <th className="px-4 py-2 text-left font-medium">{t('home.hero.customer')}</th>
            {crmEnabled ? <th className="px-3 py-2 text-center font-medium">{t('home.hero.openOpps')}</th> : null}
            <th className="px-3 py-2 text-center font-medium">{t('home.hero.openInvoices')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('home.hero.oldestDue')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('home.hero.overdue')}</th>
            <th className="px-4 py-2 text-right font-medium">{t('home.hero.open')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.partyId ?? r.name}
              onClick={r.partyId ? () => setEntity({ id: r.partyId!, name: r.name }) : undefined}
              className={`border-b border-slate-50 last:border-0 dark:border-slate-800/60 ${r.partyId ? 'cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50' : ''}`}
            >
              <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-200">{r.name}</td>
              {crmEnabled ? (
              <td className="px-3 py-2.5 text-center">
                {r.openOpportunities > 0 ? (
                  <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 tabular-nums dark:bg-violet-950/50 dark:text-violet-300">
                    {r.openOpportunities}
                  </span>
                ) : (
                  <span className="text-slate-300 dark:text-slate-600">—</span>
                )}
              </td>
              ) : null}
              <td className="px-3 py-2.5 text-center text-xs tabular-nums text-slate-500 dark:text-slate-400">{r.openInvoices}</td>
              <td className="px-3 py-2.5 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{r.oldestDue ?? '—'}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {r.overdue > 0 ? (
                  <span className="text-red-600 dark:text-red-400">{moneyCompact(r.overdue)}</span>
                ) : (
                  <span className="text-slate-300 dark:text-slate-600">—</span>
                )}
              </td>
              <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">{money(r.open)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {entity ? <EntityDrawer party={entity.id} name={entity.name} side="ar" onClose={() => setEntity(null)} /> : null}
    </>
  )
}
