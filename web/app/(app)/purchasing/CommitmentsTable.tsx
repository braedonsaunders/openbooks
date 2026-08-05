'use client'

import { useMoney } from '@/components/money-provider'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { EntityDrawer } from '../analytics/_ui/EntityDrawer'
import type { VendorExposureRow } from '../../../lib/module-home/purchasing'

/**
 * Purchasing-home hero table — one click on any vendor opens the shared
 * entity reliability drawer (payment history, reliability score, open items
 * with in-place document drill). Same drawer the AP cockpit and cash flyout
 * use, so the drill feels identical everywhere.
 */
export function CommitmentsTable({ rows }: { rows: VendorExposureRow[] }) {
  const { money, moneyCompact } = useMoney()
  const t = useTranslations('purchasing')
  const [entity, setEntity] = useState<{ id: string; name: string } | null>(null)

  return (
    <>
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
          <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
            <th className="px-4 py-2 text-left font-medium">{t('home.hero.vendor')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('home.hero.openPos')}</th>
            <th className="px-3 py-2 text-center font-medium">{t('home.hero.openBills')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('home.hero.oldestDue')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('home.hero.overdue')}</th>
            <th className="px-4 py-2 text-right font-medium">{t('home.hero.billedOpen')}</th>
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
              <td className="px-3 py-2.5 text-right tabular-nums">
                {r.openPos > 0 ? (
                  <span className="text-violet-600 dark:text-violet-400">
                    {moneyCompact(r.openPoValue)}
                    <span className="ml-1 text-[11px] text-slate-400">({r.openPos})</span>
                  </span>
                ) : (
                  <span className="text-slate-300 dark:text-slate-600">—</span>
                )}
              </td>
              <td className="px-3 py-2.5 text-center text-xs tabular-nums text-slate-500 dark:text-slate-400">
                {r.openBills > 0 ? r.openBills : '—'}
              </td>
              <td className="px-3 py-2.5 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{r.oldestDue ?? '—'}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">
                {r.overdue > 0 ? (
                  <span className="text-red-600 dark:text-red-400">{moneyCompact(r.overdue)}</span>
                ) : (
                  <span className="text-slate-300 dark:text-slate-600">—</span>
                )}
              </td>
              <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {money(r.billedOpen)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {entity ? <EntityDrawer party={entity.id} name={entity.name} side="ap" onClose={() => setEntity(null)} /> : null}
    </>
  )
}
