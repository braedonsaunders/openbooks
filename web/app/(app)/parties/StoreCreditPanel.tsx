'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button, EmptyState } from '@openbooks/ui'
import { useMoney } from '../../../components/money-provider'

/**
 * Customer drawer → Store credit: one row per currency with the available
 * balance, linking out to the stored-value register. Bearer gift cards
 * (no customer) never appear here — only store credit issued to this party.
 */
export function StoreCreditPanel({ balances }: {
  balances: { currency: string; total: string }[]
}) {
  const t = useTranslations('storedValue')
  if (balances.length === 0) {
    return (
      <EmptyState
        title={t('customer.tabLabel')}
        description={t('customer.emptyDescription')}
        action={(
          <Button asChild variant="outline">
            <Link href="/stored-value">{t('customer.viewAll')}</Link>
          </Button>
        )}
      />
    )
  }
  return (
    <section aria-label={t('customer.tabLabel')} className="space-y-3">
      <dl className="divide-y divide-border rounded-lg border border-border">
        {balances.map((row) => (
          <BalanceRow key={row.currency} currency={row.currency} total={row.total} />
        ))}
      </dl>
      <Button asChild variant="outline" size="sm">
        <Link href="/stored-value">{t('customer.viewAll')}</Link>
      </Button>
    </section>
  )
}

function BalanceRow({ currency, total }: { currency: string; total: string }) {
  const t = useTranslations('storedValue')
  const { money } = useMoney(currency)
  return (
    <div className="flex items-center justify-between px-3 py-2.5">
      <dt className="text-sm text-slate-500">{t('customer.balanceLabel')} ({currency})</dt>
      <dd className="text-sm font-semibold tabular-nums">{money(total, { currency })}</dd>
    </div>
  )
}
