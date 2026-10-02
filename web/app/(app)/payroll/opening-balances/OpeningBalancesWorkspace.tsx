'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Select } from '@openbooks/ui'
import { RecordTabs } from '../../../../components/module-home/record-tabs'
import { confirmDialog } from '../../../../lib/confirm'
import type { PayrollOpeningBalancesData } from './view'
import { OpeningBalancesView } from './OpeningBalancesView'
import { EntitlementOpeningsView } from './EntitlementOpeningsView'
import { EmployerLevyOpeningsView } from './EmployerLevyOpeningsView'

type Panel = 'employees' | 'banks' | 'employer'

/** Keep each editor mounted: changing the view must never discard a draft. */
export function OpeningBalancesWorkspace({
  balances,
  banks,
  employerLevies,
}: Pick<PayrollOpeningBalancesData, 'balances' | 'banks' | 'employerLevies'>) {
  const t = useTranslations('payroll.openingBalances.workspace')
  const common = useTranslations('common')
  const router = useRouter()
  const [panel, setPanel] = useState<Panel>('employees')
  const [dirty, setDirty] = useState<Record<Panel, number>>({
    employees: 0,
    banks: 0,
    employer: 0,
  })
  const years = [
    ...new Set([
      ...balances.initial.years,
      balances.year,
      ...Array.from({ length: 6 }, (_, i) => balances.currentYear + 1 - i),
    ]),
  ].sort((a, b) => b - a)

  async function changeYear(value: string) {
    if (
      (dirty.employees || dirty.employer) &&
      !(await confirmDialog({
        message: common('feedback.unsavedChanges'),
        confirmLabel: common('confirm.discardChanges'),
        tone: 'danger',
      }))
    )
      return
    router.push(`/payroll/opening-balances?year=${value}` as never)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800">
        <RecordTabs
          label={t('views')}
          active={panel}
          onChange={setPanel}
          tabs={(
            [
              { key: 'employees', label: t('employees') },
              { key: 'banks', label: t('banks') },
              { key: 'employer', label: t('employer') },
            ] as const
          ).map((tab) => ({
            ...tab,
            label: (
              <span>
                {tab.label}
                {dirty[tab.key] > 0 && (
                  <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">
                    {t('drafts', { count: dirty[tab.key] })}
                  </span>
                )}
              </span>
            ),
          }))}
        />
        {panel !== 'banks' && (
          <Select
            aria-label={t('taxYear')}
            value={String(balances.year)}
            onChange={(event) => void changeYear(event.target.value)}
            className="mb-2 w-32"
          >
            {years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div hidden={panel !== 'employees'}>
        <OpeningBalancesView
          {...balances}
          hideYearPicker
          onDirtyChange={(count) =>
            setDirty((current) =>
              current.employees === count
                ? current
                : { ...current, employees: count },
            )
          }
        />
      </div>
      <div hidden={panel !== 'banks'}>
        <EntitlementOpeningsView
          {...banks}
          onDirtyChange={(count) =>
            setDirty((current) =>
              current.banks === count ? current : { ...current, banks: count },
            )
          }
        />
      </div>
      <div hidden={panel !== 'employer'}>
        {employerLevies.levies.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500 dark:border-slate-800">
            {t('noLevies')}
          </p>
        ) : (
          <EmployerLevyOpeningsView
            {...employerLevies}
            onDirtyChange={(count) =>
              setDirty((current) =>
                current.employer === count
                  ? current
                  : { ...current, employer: count },
              )
            }
          />
        )}
      </div>
    </div>
  )
}
