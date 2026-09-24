'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Select } from '@openbooks/ui'
import { CASH_HORIZON_PRESETS } from '../../../../lib/cash/horizon'

/** Horizon selector — drives the ?horizon query param. */
export function HorizonControl({ value }: { value: number }) {
  const t = useTranslations('analytics.cashflow')
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function set(weeks: string) {
    const next = new URLSearchParams(params.toString())
    next.set('horizon', weeks)
    router.replace(`${pathname}?${next.toString()}`)
  }

  return (
    <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/60 px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-900/40">
      <span className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">{t('horizon.label')}</span>
      <Select value={String(value)} onChange={(e) => set(e.target.value)} triggerClassName="h-7 w-auto text-sm font-medium" aria-label={t('horizon.aria')}>
        {CASH_HORIZON_PRESETS.map((weeks) => (
          <option key={weeks} value={String(weeks)}>{t('horizon.weeks', { count: weeks })}</option>
        ))}
      </Select>
    </label>
  )
}
