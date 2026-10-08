'use client'

import { useId, useState, type ReactNode } from 'react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Gift, Landmark, PiggyBank, Plane, ShieldCheck, Sparkles, Wallet } from 'lucide-react'
import type { CompensationCategory, TotalCompensation } from '@openbooks/engine/hrm/compensation'
import { Badge, cn, Select } from '@openbooks/ui'
import { DrawerTabStrip } from '../../../components/drawer-tab-strip'
import { useDrawerResource } from '../../../components/use-drawer-resource'
import { useMoney } from '../../../components/money-provider'
import { formatDecimal } from '../../../lib/money-format'
import { EmployeeWageRates } from './EmployeeWageRates'

export type CompensationSubTab = 'total' | 'rates' | 'variable'

type Basis = 'hour' | 'week' | 'biweekly' | 'semimonth' | 'month' | 'year'
const BASES: readonly Basis[] = ['hour', 'week', 'biweekly', 'semimonth', 'month', 'year']
type Segment = CompensationCategory | 'base' | 'variable'

/** One palette for every compensation surface: a segment keeps its colour in the bar, legend and rows. */
const SEGMENT_TONE: Record<Segment, { bar: string; dot: string; icon: typeof Wallet }> = {
  base: { bar: 'bg-teal-600 dark:bg-teal-500', dot: 'bg-teal-600 dark:bg-teal-500', icon: Wallet },
  variable: { bar: 'bg-violet-500 dark:bg-violet-400', dot: 'bg-violet-500 dark:bg-violet-400', icon: Sparkles },
  retirement: { bar: 'bg-sky-500 dark:bg-sky-400', dot: 'bg-sky-500 dark:bg-sky-400', icon: PiggyBank },
  health: { bar: 'bg-emerald-500 dark:bg-emerald-400', dot: 'bg-emerald-500 dark:bg-emerald-400', icon: ShieldCheck },
  allowance: { bar: 'bg-amber-500 dark:bg-amber-400', dot: 'bg-amber-500 dark:bg-amber-400', icon: Plane },
  other: { bar: 'bg-slate-400 dark:bg-slate-500', dot: 'bg-slate-400 dark:bg-slate-500', icon: Gift },
  statutory: { bar: 'bg-rose-400 dark:bg-rose-400', dot: 'bg-rose-400 dark:bg-rose-400', icon: Landmark },
}

/**
 * The employee's Compensation tab: total compensation restated in any pay
 * basis, the wage-rate history, and bonuses and awards. Each view is its own
 * body behind the drawer's sub-tab strip. The wage-rate editor stays mounted
 * once visited so unsaved edits survive a switch.
 */
export function EmployeeCompensationPanel({
  partyId,
  canReadTotal,
  canManageWages,
}: {
  partyId: string
  /** HRM is on and the viewer holds hrm.compensation.read. */
  canReadTotal: boolean
  /** The viewer may edit employee wage rates. */
  canManageWages: boolean
}) {
  const t = useTranslations('parties.drawer.compensation')
  const tabs: { key: CompensationSubTab; label: string }[] = [
    ...(canReadTotal ? [{ key: 'total' as const, label: t('tabs.total') }] : []),
    { key: 'rates', label: t('tabs.rates') },
    ...(canReadTotal ? [{ key: 'variable' as const, label: t('tabs.variable') }] : []),
  ]
  const [subTab, setSubTab] = useState<CompensationSubTab>(tabs[0]!.key)
  const [ratesVisited, setRatesVisited] = useState(subTab === 'rates')
  const [basis, setBasis] = useState<Basis>('year')
  const [employmentId, setEmploymentId] = useState<string | null>(null)
  const [error, setError] = useState<{ url: string; message: string } | null>(null)
  const url = canReadTotal
    ? `/api/hrm/employee-compensation?employee=${encodeURIComponent(partyId)}${employmentId ? `&employment=${encodeURIComponent(employmentId)}` : ''}`
    : null
  const data = useDrawerResource<TotalCompensation>(url, (failure) => setError({ url: url ?? '', message: failure.message }))
  const failure = error && error.url === url ? error.message : null

  const select = (key: CompensationSubTab) => {
    setSubTab(key)
    if (key === 'rates') setRatesVisited(true)
  }

  return (
    <div className="space-y-5">
      {tabs.length > 1 ? (
        <DrawerTabStrip tabs={tabs} activeKey={subTab} onSelect={select} ariaLabel={t('tabs.ariaLabel')} />
      ) : null}
      {canReadTotal && data && data.employments.length > 1 && subTab !== 'rates' ? (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-slate-500 dark:text-slate-400">{t('employment')}</span>
          <Select
            aria-label={t('employment')}
            value={data.employmentId}
            onChange={(event) => setEmploymentId(event.target.value)}
            className="w-auto"
          >
            {data.employments.map((option) => <option key={option.id} value={option.id}>{option.employer}</option>)}
          </Select>
        </div>
      ) : null}
      {subTab !== 'rates' && canReadTotal ? (
        failure ? (
          <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
            {failure}
          </div>
        ) : !data ? (
          <CompensationSkeleton />
        ) : subTab === 'total' ? (
          <TotalCompensationView data={data} basis={basis} onBasisChange={setBasis} />
        ) : (
          <VariablePayView data={data} />
        )
      ) : null}
      <div hidden={subTab !== 'rates'} className="space-y-6">
        {canReadTotal && data && data.history.length > 0 ? <PayProgression data={data} /> : null}
        {canManageWages && (ratesVisited || subTab === 'rates') ? <EmployeeWageRates partyId={partyId} /> : null}
        {!canManageWages && canReadTotal && data ? <RateHistoryList data={data} /> : null}
      </div>
    </div>
  )
}

function CompensationSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="h-40 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-800/60" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60" />
      <div className="h-24 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60" />
    </div>
  )
}

function useBasisLabels() {
  const t = useTranslations('parties.drawer.compensation')
  return {
    short: (basis: Basis) => t(`basis.short.${basis}`),
    per: (basis: Basis) => t(`basis.per.${basis}`),
  }
}

function BasisSwitch({ value, onChange }: { value: Basis; onChange: (basis: Basis) => void }) {
  const t = useTranslations('parties.drawer.compensation')
  const labels = useBasisLabels()
  return (
    <div role="radiogroup" aria-label={t('basis.ariaLabel')} className="inline-flex flex-wrap gap-0.5 rounded-lg bg-white/15 p-0.5 backdrop-blur-sm">
      {BASES.map((basis) => (
        <button
          key={basis}
          type="button"
          role="radio"
          aria-checked={value === basis}
          onClick={() => onChange(basis)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            value === basis ? 'bg-white text-teal-800 shadow-sm' : 'text-white/80 hover:bg-white/10 hover:text-white',
          )}
        >
          {labels.short(basis)}
        </button>
      ))}
    </div>
  )
}

function TotalCompensationView({ data, basis, onBasisChange }: { data: TotalCompensation; basis: Basis; onBasisChange: (basis: Basis) => void }) {
  const t = useTranslations('parties.drawer.compensation')
  const format = useFormatter()
  const locale = useLocale()
  const labels = useBasisLabels()
  const currency = data.totals?.currency ?? data.base?.currency
  const { money } = useMoney(currency || undefined)
  const date = (value: string) => format.dateTime(new Date(`${value}T12:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' })

  if (!data.base || !data.totals) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 px-6 py-10 text-center dark:border-slate-700">
        <Wallet className="mx-auto h-8 w-8 text-slate-400" aria-hidden />
        <p className="mt-3 font-medium text-slate-800 dark:text-slate-200">{t('noRate.title')}</p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('noRate.body')}</p>
      </div>
    )
  }
  const totals = data.totals
  const base = data.base
  const employerItems = data.recurring.filter((item) => item.paidBy === 'employer')
  const employeeItems = data.recurring.filter((item) => item.paidBy === 'employee')
  const otherCurrency = [
    ...data.recurring.filter((item) => item.currency && item.currency !== totals.currency && item.annual !== null),
    ...data.statutory.filter((item) => item.currency !== totals.currency),
    ...data.variable.filter((item) => item.currency !== totals.currency),
  ]
  const share = (value: string) => formatDecimal(locale, value, { maximumFractionDigits: 1 })
  const segments = totals.byCategory.filter((segment) => Number(segment.share) > 0)

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-teal-700 via-teal-600 to-emerald-600 p-5 text-white shadow-sm dark:from-teal-900 dark:via-teal-800 dark:to-emerald-900">
        <div className="pointer-events-none absolute -top-16 -right-16 h-48 w-48 rounded-full bg-white/10 blur-2xl" aria-hidden />
        <div className="relative flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium tracking-wide text-white/75 uppercase">{t('hero.title')}</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums sm:text-4xl">
              {money(totals.equivalents[basis], { currency: totals.currency })}
              <span className="ml-1.5 text-base font-normal text-white/75">{labels.per(basis)}</span>
            </p>
            {basis !== 'hour' ? (
              <p className="mt-1 text-sm text-white/85 tabular-nums">
                {t('hero.perHour', { amount: money(totals.equivalents.hour, { currency: totals.currency }) })}
              </p>
            ) : (
              <p className="mt-1 text-sm text-white/85 tabular-nums">
                {t('hero.perYear', { amount: money(totals.equivalents.year, { currency: totals.currency }) })}
              </p>
            )}
          </div>
          <BasisSwitch value={basis} onChange={onBasisChange} />
        </div>
        <div className="relative mt-5">
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-white/20" role="img" aria-label={t('composition.ariaLabel')}>
            {segments.map((segment) => (
              <div
                key={segment.category}
                className={cn('h-full border-r border-white/40 last:border-r-0', SEGMENT_TONE[segment.category].bar)}
                style={{ width: `${segment.share}%` }}
                title={`${t(`segments.${segment.category}`)} · ${share(segment.share)}%`}
              />
            ))}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-white/90">
            {segments.map((segment) => (
              <li key={segment.category} className="flex items-center gap-1.5">
                <span className={cn('h-2 w-2 rounded-full ring-1 ring-white/50', SEGMENT_TONE[segment.category].dot)} aria-hidden />
                <span>{t(`segments.${segment.category}`)}</span>
                <span className="tabular-nums text-white/70">{share(segment.share)}%</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label={t('stats.base')} value={money(data.base.equivalents[basis], { currency: data.base.currency })} hint={labels.per(basis)} />
        <StatTile
          label={t('stats.benefits')}
          value={money(sumEquivalents(totals, ['retirement', 'health', 'allowance', 'other'], basis), { currency: totals.currency })}
          hint={t('stats.projected')}
        />
        <StatTile
          label={t('stats.statutoryAndVariable')}
          value={money(sumEquivalents(totals, ['statutory', 'variable'], basis), { currency: totals.currency })}
          hint={data.actualsWindow ? t('stats.trailing') : t('stats.payrollOff')}
        />
      </div>

      <Section title={t('base.title')} icon={Wallet} tone="base">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {money(data.base.rate, { currency: data.base.currency, maximumFractionDigits: 4 })}
            <span className="ml-1 text-sm font-normal text-slate-500 dark:text-slate-400">{labels.per(data.base.basis)}</span>
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {data.base.scope !== 'employee' ? <Badge variant="outline">{t(`base.scope.${data.base.scope}`)}</Badge> : null}
            <Badge variant="outline">{t('base.since', { date: date(data.base.effectiveFrom) })}</Badge>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-6">
          {BASES.map((key) => (
            <div key={key} className={cn('rounded-lg px-2 py-1.5', key === basis ? 'bg-teal-50 dark:bg-teal-950/40' : '')}>
              <dt className="text-[11px] font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{labels.short(key)}</dt>
              <dd className="text-sm font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(base.equivalents[key], { currency: base.currency })}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          {t(data.annualHoursSource === 'rate' ? 'base.hoursFromRate' : 'base.hoursFromSettings', { hours: formatDecimal(locale, data.annualHours, { maximumFractionDigits: 2 }) })}
          {data.payroll.schedule ? ` · ${t('base.schedule', { name: data.payroll.schedule.name, periods: data.payroll.schedule.periodsPerYear })}` : ''}
        </p>
      </Section>

      <Section title={t('benefits.title')} icon={PiggyBank} tone="retirement" subtitle={t('benefits.subtitle')}>
        {employerItems.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('benefits.empty')}</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {employerItems.map((item) => (
              <RecurringRow key={item.key} item={item} basis={basis} currency={totals.currency} />
            ))}
          </ul>
        )}
      </Section>

      {employeeItems.length > 0 ? (
        <Section title={t('employeePaid.title')} icon={Wallet} tone="other" subtitle={t('employeePaid.subtitle')}>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {employeeItems.map((item) => (
              <RecurringRow key={item.key} item={item} basis={basis} currency={totals.currency} muted />
            ))}
          </ul>
        </Section>
      ) : null}

      {data.actualsWindow ? (
        <Section
          title={t('statutory.title')}
          icon={Landmark}
          tone="statutory"
          subtitle={t('statutory.subtitle', { from: date(data.actualsWindow.from), to: date(data.actualsWindow.to) })}
        >
          {data.statutory.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('statutory.empty')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.statutory.map((line) => (
                <li key={`${line.key}:${line.currency}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="text-slate-700 dark:text-slate-300">{line.name}</span>
                  <span className="tabular-nums text-slate-900 dark:text-slate-100">{money(line.amount, { currency: line.currency })}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {otherCurrency.length > 0 ? (
        <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-900/60 dark:text-slate-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('otherCurrency', { currency: totals.currency })}
        </p>
      ) : null}

      {data.history.length > 1 ? <PayProgression data={data} compact /> : null}
    </div>
  )
}

function sumEquivalents(totals: NonNullable<TotalCompensation['totals']>, categories: Segment[], basis: Basis): string {
  // Display-only aggregation of server-restated cent amounts: summed as
  // integer cents so no binary fraction ever reaches the screen.
  let cents = 0n
  for (const segment of totals.byCategory) {
    if (!categories.includes(segment.category)) continue
    const [whole = '0', fraction = ''] = segment.equivalents[basis].replace('-', '').split('.')
    const value = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2))
    cents += segment.equivalents[basis].startsWith('-') ? -value : value
  }
  const negative = cents < 0n
  const absolute = negative ? -cents : cents
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`
}

function StatTile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
      <p className="truncate text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{value}</p>
      <p className="truncate text-xs text-slate-500 dark:text-slate-400">{hint}</p>
    </div>
  )
}

function Section({ title, subtitle, icon: Icon, tone, children }: { title: string; subtitle?: string; icon: typeof Wallet; tone: Segment; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <header className="mb-3 flex items-center gap-2.5">
        <span className={cn('flex h-7 w-7 items-center justify-center rounded-lg text-white', SEGMENT_TONE[tone].bar)}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          {subtitle ? <p className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</p> : null}
        </div>
      </header>
      {children}
    </section>
  )
}

function RecurringRow({ item, basis, currency, muted = false }: {
  item: TotalCompensation['recurring'][number]; basis: Basis; currency: string; muted?: boolean
}) {
  const t = useTranslations('parties.drawer.compensation')
  const labels = useBasisLabels()
  const { money } = useMoney(item.currency || currency)
  return (
    <li className="flex items-start justify-between gap-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', SEGMENT_TONE[item.category].dot)} aria-hidden />
        <div className="min-w-0">
          <p className={cn('truncate text-sm font-medium', muted ? 'text-slate-600 dark:text-slate-400' : 'text-slate-800 dark:text-slate-200')}>{item.name}</p>
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">
            {[item.program, t(`segments.${item.category}`)].filter(Boolean).join(' · ')}
          </p>
          {item.refusal ? (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {item.refusal}
            </p>
          ) : null}
        </div>
      </div>
      {item.equivalents ? (
        <div className="shrink-0 text-right">
          <p className={cn('text-sm tabular-nums', muted ? 'text-slate-600 dark:text-slate-400' : 'font-medium text-slate-900 dark:text-slate-100')}>
            {money(item.equivalents[basis], { currency: item.currency || currency })}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">{labels.per(basis)}</p>
        </div>
      ) : (
        <span className="shrink-0 text-xs text-slate-400">{t('notPriced')}</span>
      )}
    </li>
  )
}

/** Annual pay over time as a step chart, newest change called out. */
function PayProgression({ data, compact = false }: { data: TotalCompensation; compact?: boolean }) {
  const t = useTranslations('parties.drawer.compensation')
  const format = useFormatter()
  const locale = useLocale()
  const currency = data.base?.currency ?? data.history[0]?.currency
  const { money } = useMoney(currency || undefined)
  const points = [...data.history].filter((row) => row.currency === currency).reverse()
  if (points.length === 0) return null
  const values = points.map((row) => Number(row.annual))
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || max || 1
  const width = 560
  const height = compact ? 72 : 112
  const pad = 6
  const x = (index: number) => points.length === 1 ? width / 2 : pad + (index * (width - pad * 2)) / (points.length - 1)
  const y = (value: number) => height - pad - ((value - (max === min ? 0 : min)) / span) * (height - pad * 2)
  let path = ''
  points.forEach((_, index) => {
    const px = x(index)
    const py = y(values[index]!)
    path += index === 0 ? `M ${px} ${py}` : ` H ${px} V ${py}`
  })
  const area = `${path} H ${x(points.length - 1)} V ${height} H ${x(0)} Z`
  const fillId = useId()
  const latest = data.history[0]!
  const first = points[0]!
  const date = (value: string) => format.dateTime(new Date(`${value}T12:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' })
  const change = latest.changePercent
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('progression.title')}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('progression.subtitle', { from: date(first.effectiveFrom), count: points.length })}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">{money(latest.annual, { currency: latest.currency })}<span className="ml-1 text-xs font-normal text-slate-500">{t('basis.per.year')}</span></p>
          {change !== null ? (
            <p className={cn('inline-flex items-center gap-0.5 text-xs font-medium tabular-nums', Number(change) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
              {Number(change) >= 0 ? <ArrowUpRight className="h-3 w-3" aria-hidden /> : <ArrowDownRight className="h-3 w-3" aria-hidden />}
              {t('progression.lastChange', { percent: formatDecimal(locale, change, { maximumFractionDigits: 2, signDisplay: 'exceptZero' }) })}
            </p>
          ) : null}
        </div>
      </header>
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-3 h-auto w-full" role="img" aria-label={t('progression.ariaLabel')}>
        <defs>
          <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="text-teal-600 dark:text-teal-400">
          <path d={area} fill={`url(#${fillId})`} />
          <path d={path} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          {points.map((row, index) => (
            <circle key={row.id} cx={x(index)} cy={y(values[index]!)} r={3.5} fill="currentColor">
              <title>{`${date(row.effectiveFrom)} · ${money(row.annual, { currency: row.currency })}`}</title>
            </circle>
          ))}
        </g>
      </svg>
    </section>
  )
}

function RateHistoryList({ data }: { data: TotalCompensation }) {
  const t = useTranslations('parties.drawer.compensation')
  const format = useFormatter()
  const locale = useLocale()
  const labels = useBasisLabels()
  const { money } = useMoney(data.base?.currency || data.history[0]?.currency || undefined)
  const date = (value: string) => format.dateTime(new Date(`${value}T12:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' })
  if (data.history.length === 0) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">{t('history.empty')}</p>
  }
  return (
    <ol className="relative space-y-4 border-l border-slate-200 pl-5 dark:border-slate-800">
      {data.history.map((row) => (
        <li key={row.id} className="relative">
          <span className={cn('absolute top-1.5 -left-[25px] h-2.5 w-2.5 rounded-full ring-4 ring-white dark:ring-slate-900', row.current ? 'bg-teal-600' : 'bg-slate-300 dark:bg-slate-600')} aria-hidden />
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium tabular-nums text-slate-900 dark:text-slate-100">
              {money(row.rate, { currency: row.currency, maximumFractionDigits: 4 })}
              <span className="ml-1 font-normal text-slate-500 dark:text-slate-400">{labels.per(row.basis)}</span>
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {row.effectiveTo ? t('history.window', { from: date(row.effectiveFrom), to: date(row.effectiveTo) }) : t('history.since', { from: date(row.effectiveFrom) })}
            </p>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {t('history.equivalent', { hourly: money(row.hourly, { currency: row.currency }), annual: money(row.annual, { currency: row.currency }) })}
            {row.changePercent !== null ? ` · ${formatDecimal(locale, row.changePercent, { maximumFractionDigits: 2, signDisplay: 'exceptZero' })}%` : ''}
          </p>
          {row.cycle || row.notes ? (
            <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
              {row.cycle ? <Badge variant="outline" className="mr-1.5">{row.cycle.name}</Badge> : null}
              {row.cycle?.reason ?? row.notes}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

function VariablePayView({ data }: { data: TotalCompensation }) {
  const t = useTranslations('parties.drawer.compensation')
  const format = useFormatter()
  const currency = data.totals?.currency ?? data.base?.currency ?? data.variableHistory[0]?.currency
  const { money } = useMoney(currency || undefined)
  const date = (value: string) => format.dateTime(new Date(`${value}T12:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' })
  const pendingAwards = data.awards.filter((award) => award.status !== 'delivered' && award.status !== 'rejected')
  if (!data.payroll.enabled && data.awards.length === 0) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">{t('variable.payrollOff')}</p>
  }
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label={t('variable.trailing')}
          value={data.totals ? money(data.totals.variable, { currency: data.totals.currency }) : '—'}
          hint={data.actualsWindow ? t('variable.window', { from: date(data.actualsWindow.from) }) : t('stats.payrollOff')}
        />
        <StatTile label={t('variable.payments')} value={String(data.variable.length)} hint={t('variable.paymentsHint')} />
        <StatTile label={t('variable.pending')} value={String(pendingAwards.length)} hint={t('variable.pendingHint')} />
      </div>
      <Section title={t('variable.historyTitle')} icon={Sparkles} tone="variable">
        {data.variableHistory.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('variable.empty')}</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.variableHistory.map((payment, index) => (
              <li key={`${payment.payDate}:${index}`} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">{payment.name}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {date(payment.payDate)}
                    {payment.runType !== 'regular' ? ` · ${t(`variable.runTypes.${payment.runType === 'bonus' || payment.runType === 'supplemental' || payment.runType === 'termination' || payment.runType === 'retro' ? payment.runType : 'other'}`)}` : ''}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-medium tabular-nums text-slate-900 dark:text-slate-100">{money(payment.amount, { currency: payment.currency })}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {data.awards.length > 0 ? (
        <Section title={t('variable.awardsTitle')} icon={Gift} tone="other" subtitle={t('variable.awardsSubtitle')}>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.awards.map((award) => (
              <li key={award.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">{award.program || t('variable.awardFallback')}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{date(award.periodFrom)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={award.status === 'delivered' ? 'success' : 'outline'}>{t(`variable.awardStatus.${['delivered', 'rejected'].includes(award.status) ? award.status : 'pending'}`)}</Badge>
                  <span className="text-sm tabular-nums text-slate-900 dark:text-slate-100">{money(award.value, { currency: award.currency })}</span>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  )
}
