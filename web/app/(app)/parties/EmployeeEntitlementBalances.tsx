'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { Settings2 } from 'lucide-react'
import { Badge, Button } from '@openbooks/ui'
import { PagedTable } from '../../../components/paged-table'

interface BalanceRow {
  planId: string
  planCode: string
  planName: string
  unit: 'money' | 'hours'
  direction: 'accrue' | 'owe'
  balance: string
  balanceMoney: string | null
  balanceHours: string | null
  wage: string | null
  maxBalance: string | null
  notifyBalance: string | null
  limitScope: string | null
  overLimit: boolean
  nearLimit: boolean
  lastMovementDate: string | null
}

interface MovementRow {
  id: string
  plan_code: string
  plan_name: string
  unit: 'money' | 'hours'
  movement_date: string
  amount: string
  hours: string | null
  kind: string
  note: string | null
  run_number: string | null
}

/**
 * Pay banks on the employee record, beside the payroll profile and wage
 * history — the same place every other compensation fact about this person
 * already lives. Read-only: a bank moves through payroll or an explicit
 * adjustment, never by typing a new balance over the old one (the ledger is
 * append-only and is the balance).
 *
 * Money balances are shown with their hours equivalent at the CURRENT wage,
 * which is the honest way round: the dollars are what the employer owes, the
 * hours are what they currently buy.
 */
export function EmployeeEntitlementBalances({ partyId }: { partyId: string }) {
  const t = useTranslations('payroll.entitlements')
  const tc = useTranslations('common')
  const format = useFormatter()
  const [data, setData] = useState<{
    currency: string
    balances: BalanceRow[]
    movements: MovementRow[]
  } | null>(null)
  const [loadError, setLoadError] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadError(false)
    try {
      const response = await fetch(`/api/payroll/entitlements?employee=${encodeURIComponent(partyId)}`, { signal })
      if (!response.ok) throw new Error('load failed')
      setData(await response.json())
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setLoadError(true)
      setData(null)
    }
  }, [partyId])

  useEffect(() => {
    setData(null)
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const hours = (value: string) => format.number(Number(value), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  const formatDate = (value: string) => format.dateTime(new Date(`${value}T12:00:00Z`), {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  })

  if (loadError) {
    return (
      <section className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-center dark:border-rose-900 dark:bg-rose-950/30">
        <p className="text-sm text-rose-700 dark:text-rose-300">{tc('feedback.loadFailed')}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => void load()}>
          {tc('actions.retry')}
        </Button>
      </section>
    )
  }
  if (data === null) {
    return <p className="py-6 text-center text-sm text-slate-400">{tc('feedback.loading')}</p>
  }

  const money = (value: string) => format.number(Number(value), {
    style: 'currency',
    currency: data.currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  const inUnit = (row: { unit: 'money' | 'hours' }, value: string) =>
    row.unit === 'hours' ? `${hours(value)} ${t('hoursSuffix')}` : money(value)

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('hint')}</p>
        </div>
        <Link
          href={'/admin/setup/payroll?tab=entitlements' as never}
          className="flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
        >
          <Settings2 size={13} aria-hidden /> {t('managePlans')}
        </Link>
      </div>

      {data.balances.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 py-6 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {t('noPlans')}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.balances.map((row) => (
            <div
              key={row.planId}
              className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{row.planName}</p>
                  <p className="font-mono text-xs text-slate-500 dark:text-slate-400">{row.planCode}</p>
                </div>
                {row.overLimit ? <Badge variant="destructive">{t('overLimit')}</Badge>
                  : row.nearLimit ? <Badge variant="warning">{t('nearLimit')}</Badge>
                  : null}
              </div>
              <p className="mt-2 text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {inUnit(row, row.balance)}
              </p>
              {/* The hours view is a display of the money at today's wage —
                  never a second stored figure. */}
              {row.unit === 'money' && row.balanceHours && row.wage ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t('hoursAtWage', { hours: hours(row.balanceHours), wage: money(row.wage) })}
                </p>
              ) : null}
              {row.unit === 'hours' && row.balanceMoney ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t('worthToday', { amount: money(row.balanceMoney) })}
                </p>
              ) : null}
              {row.direction === 'owe' && Number(row.balance) < 0 ? (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t('owedBack')}</p>
              ) : null}
              {row.maxBalance ? (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {t('limitLine', {
                    limit: inUnit(row, row.maxBalance),
                    scope: row.limitScope ? t(`scope.${row.limitScope}`) : '',
                  })}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {data.movements.length > 0 ? (
        <PagedTable
          rows={data.movements}
          rowKey={(row) => row.id}
          searchable
          pageSize={10}
          empty={<p className="py-6 text-center text-sm text-slate-400">{t('noMovements')}</p>}
          columns={[
            {
              key: 'date',
              header: t('movementDate'),
              search: (row) => row.movement_date,
              cell: (row) => <span className="tabular-nums">{formatDate(row.movement_date)}</span>,
            },
            {
              key: 'plan',
              header: t('plan'),
              search: (row) => `${row.plan_code} ${row.plan_name}`,
              cell: (row) => row.plan_name,
            },
            {
              key: 'kind',
              header: t('movementKind'),
              search: (row) => row.kind,
              cell: (row) => <Badge variant="secondary">{t(`kind.${row.kind}`)}</Badge>,
            },
            {
              key: 'amount',
              header: t('amount'),
              align: 'right',
              search: (row) => row.amount,
              cell: (row) => <span className="tabular-nums">{inUnit(row, row.amount)}</span>,
            },
            {
              key: 'source',
              header: t('source'),
              search: (row) => row.run_number ?? row.note ?? '',
              cell: (row) => (
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {row.run_number ?? row.note ?? '—'}
                </span>
              ),
            },
          ]}
        />
      ) : null}
    </section>
  )
}
