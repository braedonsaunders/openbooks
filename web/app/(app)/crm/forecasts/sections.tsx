import type { ComponentProps } from 'react'
import Link from 'next/link'
import { Settings2 } from 'lucide-react'
import { Badge, Button } from '@openbooks/ui'
import { KpiStrip, type Kpi } from '../../../../components/kpi-strip'
import { DateRangeFilter } from '../../../../components/date-range-filter'
import { SearchSelectFilter } from '../../../../components/filter-bar'
import { ForecastSnapshotButton } from '../ForecastSnapshotButton'

/**
 * Pieces of the forecasts page shared by the page and the widget registry.
 *
 * Every one of these is a conditional composite or a component the spec
 * language cannot name: the section wrapper carries aria-labelledby plus an
 * icon heading, the KPI group pairs a currency badge with a strip, the header
 * actions mix an asChild link with a gated client button. `when` omits a
 * block; it does not choose between two.
 */

export function ForecastSection({
  labelledBy,
  children,
}: {
  labelledBy: string
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={labelledBy} className="space-y-3">
      {children}
    </section>
  )
}

export function ForecastSectionHeading({
  id,
  icon,
  title,
  description,
}: {
  id: string
  icon: React.ReactNode
  title: string
  description?: string
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 text-teal-700 dark:text-teal-300">{icon}</span>
      <div>
        <h2 id={id} className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{description}</p> : null}
      </div>
    </div>
  )
}

export function ForecastKpiGroup({ currency, items }: { currency: string; items: Kpi[] }) {
  return (
    <div className="space-y-2">
      <Badge variant="secondary">{currency}</Badge>
      <KpiStrip items={items} />
    </div>
  )
}

export function ForecastFilters({
  fromKey,
  toKey,
  fromLabel,
  toLabel,
  defaultFrom,
  defaultTo,
  ownerLabel,
  ownerOptions,
  teamLabel,
  teamOptions,
}: {
  fromKey: string
  toKey: string
  fromLabel: string
  toLabel: string
  defaultFrom: string
  defaultTo: string
  ownerLabel: string
  ownerOptions: { value: string; label: string }[]
  teamLabel: string
  teamOptions: { value: string; label: string }[]
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DateRangeFilter
        fromKey={fromKey}
        toKey={toKey}
        fromLabel={fromLabel}
        toLabel={toLabel}
        defaultFrom={defaultFrom}
        defaultTo={defaultTo}
        clearable={false}
      />
      <SearchSelectFilter
        paramKey="owner"
        label={ownerLabel}
        options={ownerOptions}
        resetParamKeys={['team']}
        className="w-full sm:w-48"
      />
      <SearchSelectFilter
        paramKey="team"
        label={teamLabel}
        options={teamOptions}
        resetParamKeys={['owner']}
        className="w-full sm:w-48"
      />
    </div>
  )
}

export function ManageQuotasButton({
  href,
  label,
  ariaLabel,
}: {
  href: string
  label: string
  ariaLabel: string
}) {
  return (
    <Button variant="outline" size="sm" asChild>
      <Link href={href as never} aria-label={ariaLabel}>
        <Settings2 size={15} />
        <span className="hidden sm:inline">{label}</span>
      </Link>
    </Button>
  )
}

export function QuotaEmptyAction({ href, label, size }: { href: string; label: string; size: string }) {
  return (
    <Button size={size as ComponentProps<typeof Button>['size']} asChild>
      <Link href={href as never}>{label}</Link>
    </Button>
  )
}

export function ForecastSnapshotAction({
  periodStart,
  periodEnd,
  ownerUserId,
  salesTeamId,
}: {
  periodStart: string
  periodEnd: string
  ownerUserId: string | null
  salesTeamId: string | null
}) {
  return (
    <ForecastSnapshotButton
      periodStart={periodStart}
      periodEnd={periodEnd}
      ownerUserId={ownerUserId}
      salesTeamId={salesTeamId}
    />
  )
}
