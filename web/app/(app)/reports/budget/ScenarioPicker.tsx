'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Select } from '@openbooks/ui'

/** Budget scenario selector — swaps the ?scenario= param, preserving other filters. */
export function ScenarioPicker({
  scenarios,
  value,
}: {
  scenarios: { id: string; name: string; fiscalYear: number; kind: string; status: string }[]
  value: string
}) {
  const t = useTranslations('reports.budget')
  const tb = useTranslations('budgets')
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('scenario')}</span>
      <Select
        value={value}
        className="w-72"
        aria-label={t('scenario')}
        onChange={(e) => {
          const next = new URLSearchParams(params.toString())
          next.set('scenario', e.target.value)
          router.replace(`${pathname}?${next.toString()}`)
        }}
      >
        {scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {t('scenarioOption', { name: s.name, year: s.fiscalYear, status: tb(`status.${s.status}`) })}
          </option>
        ))}
      </Select>
    </label>
  )
}
