'use client'

import { useMoney } from '@/components/money-provider'
import { cmp as compareMoney } from '@openbooks/engine/src/money/money.ts'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Drawer } from '@openbooks/ui'
import { SlidersHorizontal, Landmark, ArrowUpRight } from 'lucide-react'
import { formatCivilDate } from '@/lib/format'
import { Panel } from '../../analytics/_ui/Panel'
import { CategoryManager, type CatOption, type AccountOption } from '../../analytics/_ui/CategoryManager'
import type { ForecastCategory } from '../../../../lib/cash/core'
/**
 * Cash forecast configuration — the model behind the liquidity timeline. This
 * is the Cash cockpit's config: the recurring forecast categories (payroll,
 * rent, loans — the non-AR/AP flows) and the forecast model's parameters,
 * ported at full fidelity from the analytics Configuration tab. The AP
 * pay-selection rule is AP's config — shown read-only here with a link to its
 * home on the AP cockpit, never duplicated as a second editable copy.
 */
export function CashForecastConfigDrawer({
  onClose,
  title,
  description,
  asOf,
  horizonWeeks,
  dso,
  dpo,
  weeklyCap,
  restrictToSafe,
  vendorOptions,
  accountOptions,
  subsidiaryOptions,
  initialCategories,
}: {
  onClose: () => void
  title: string
  description: string
  asOf: string
  horizonWeeks: number
  dso: number
  dpo: number
  weeklyCap: string
  restrictToSafe: boolean
  vendorOptions: CatOption[]
  accountOptions: AccountOption[]
  subsidiaryOptions: CatOption[]
  initialCategories?: ForecastCategory[]
}) {
  const { money } = useMoney()
  const t = useTranslations('banking.cash.config')
  const locale = useLocale()
  const items: { label: string; value: string; note: string }[] = [
    { label: t('horizonLabel'), value: t('horizonValue', { weeks: horizonWeeks }), note: t('horizonNote') },
    { label: t('asOfLabel'), value: formatCivilDate(asOf, locale), note: t('asOfNote') },
    { label: t('methodLabel'), value: t('methodValue'), note: t('methodNote') },
    { label: t('overdueLabel'), value: t('overdueValue'), note: t('overdueNote') },
    { label: t('snapLabel'), value: t('snapOn'), note: t('snapNote') },
    { label: t('dsoLabel'), value: t('dsoValue', { dso, dpo }), note: t('dsoNote') },
  ]

  return (
    <Drawer open onClose={onClose} size="xl" title={title} description={description} bodyClassName="overflow-y-auto">
      <div className="space-y-5">
        <CategoryManager vendorOptions={vendorOptions} accountOptions={accountOptions} subsidiaryOptions={subsidiaryOptions} initialCategories={initialCategories} />

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Panel title={t('modelTitle')} icon={SlidersHorizontal} bodyClassName="p-0">
            <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
              {items.map((i) => (
                <li key={i.label} className="flex items-start justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{i.label}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{i.note}</p>
                  </div>
                  <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-right text-sm font-semibold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-200">{i.value}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel
            title={t('apTitle')}
            icon={Landmark}
            hint={t('apHint')}
            bodyClassName="p-0"
          >
            <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
              <li className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{t('capLabel')}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t('capNote')}</p>
                </div>
                <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-sm font-semibold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-200">{compareMoney(weeklyCap, '0.0000') > 0 ? money(weeklyCap) : t('capUnlimited')}</span>
              </li>
              <li className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{t('restrictLabel')}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t('restrictNote')}</p>
                </div>
                <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-sm font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">{restrictToSafe ? t('restrictOn') : t('restrictOff')}</span>
              </li>
              <li className="px-4 py-3">
                <Link href={('/ap')} className="inline-flex items-center gap-1 text-xs font-medium text-teal-600 hover:underline dark:text-teal-400">
                  {t('apLink')} <ArrowUpRight size={12} />
                </Link>
              </li>
            </ul>
          </Panel>
        </div>
      </div>
    </Drawer>
  )
}
