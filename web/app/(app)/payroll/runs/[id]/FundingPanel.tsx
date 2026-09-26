'use client'

/** Split from RunWizard.tsx; moved without behavior changes. */
import { type Funding } from './run-wizard-model'
import { HeaderFact } from './run-wizard-controls'
import { useTranslations } from 'next-intl'
import { cn } from '@openbooks/ui'

/**
 * Cash required to fund the payday, beside what each bank account actually
 * holds — the question every controller asks at commit and no ledger preview
 * answers. Lead time is business days to the pay date, because a bank file
 * submitted the morning of payday does not land on payday.
 */
export function FundingPanel({
  funding,
  fmt,
}: {
  funding: Funding
  fmt: (v: string | number | null | undefined) => string
}) {
  const t = useTranslations('payroll')
  const days = funding.businessDaysToPayDate
  const short = funding.accounts.length > 0 && funding.accounts.every((a) => !a.sufficient)

  return (
    <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {t('wizard.funding.title')}
        </h3>
        <span
          className={cn(
            'text-xs',
            days < 0
              ? 'text-amber-600 dark:text-amber-400'
              : days <= 2
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-slate-500 dark:text-slate-400',
          )}
        >
          {days < 0
            ? t('wizard.funding.payDatePast', { date: funding.payDate })
            : t('wizard.funding.leadTime', { days, date: funding.payDate })}
        </span>
      </div>
      <div className="grid gap-4 px-4 py-3 sm:grid-cols-3">
        <HeaderFact label={t('wizard.funding.netPay')}>{fmt(funding.netPay)}</HeaderFact>
        <HeaderFact label={t('wizard.funding.liabilities')}>{fmt(funding.liabilities)}</HeaderFact>
        <HeaderFact label={t('wizard.funding.totalCost')}>{fmt(funding.totalCost)}</HeaderFact>
      </div>
      {/* The same net pay, split by how it leaves. A direct-deposit file is
          drawn on the payday; cheques clear when they are presented — so a
          single cash-required number is not the question being asked. */}
      <div className="grid gap-4 border-t border-slate-100 px-4 py-3 sm:grid-cols-2 dark:border-slate-800">
        {funding.rails.map((railTotal) => (
          <HeaderFact
            key={railTotal.method}
            label={t(`wizard.funding.rail.${railTotal.method}`, { count: railTotal.employees })}
          >
            {fmt(railTotal.netPay)}
          </HeaderFact>
        ))}
      </div>
      {funding.accounts.length > 0 && (
        <div className="border-t border-slate-100 px-4 py-3 dark:border-slate-800">
          <p className="mb-2 text-xs font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">
            {t('wizard.funding.accounts')}
          </p>
          <ul className="space-y-1 text-sm">
            {funding.accounts.map((account) => (
              <li key={account.id} className="flex items-center justify-between gap-3">
                <span className="truncate text-slate-700 dark:text-slate-200">{account.label}</span>
                <span
                  className={cn(
                    'tabular-nums',
                    account.sufficient
                      ? 'text-slate-700 dark:text-slate-200'
                      : 'font-medium text-amber-600 dark:text-amber-400',
                  )}
                >
                  {fmt(account.balance)}
                </span>
              </li>
            ))}
          </ul>
          {short && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              {t('wizard.funding.short', { amount: fmt(funding.netPay) })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
