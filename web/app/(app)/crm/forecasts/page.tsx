import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { Camera, Gauge, History, Settings2 } from 'lucide-react'
import { db } from '@openbooks/engine/src/db.ts'
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { DateRangeFilter } from '../../../../components/date-range-filter'
import { SearchSelectFilter } from '../../../../components/filter-bar'
import { KpiStrip } from '../../../../components/kpi-strip'
import { ListPageLayout } from '../../../../components/page-layout'
import { addCalendarDays, addCalendarMonthsStart, businessToday, startOfMonth } from '@openbooks/engine/src/business-date.ts'
import { can, requirePermission } from '../../../../lib/authz'
import { calculateForecast } from '../../../../lib/crm'
import { isUuid, pickString } from '../../../../lib/list-params'
import { getMoneyFormatter } from '../../../../lib/money-server'
import { ForecastSnapshotButton } from '../ForecastSnapshotButton'

export const dynamic = 'force-dynamic'

const DATE = /^\d{4}-\d{2}-\d{2}$/

type ForecastRow = {
  currency: string
  pipeline_amount: string
  weighted_amount: string
  worst_case_amount: string
  most_likely_amount: string
  upside_amount: string
  closed_amount: string
}

type QuotaRow = {
  id: string
  owner_name: string | null
  team_name: string | null
  period_start: string
  period_end: string
  currency: string
  amount: string
}

type SnapshotRow = ForecastRow & {
  id: string
  owner_name: string | null
  team_name: string | null
  as_of: string | Date
  snapshot_kind: 'calculated' | 'rep_override' | 'manager_override'
  override_amount: string | null
}

export default async function Forecasts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('crm.forecasts.read')
  const [t, locale, { money }] = await Promise.all([
    getTranslations('crm'),
    getLocale(),
    getMoneyFormatter(authz.user.orgId),
  ])
  const sp = await searchParams
  const today = await businessToday(authz.user.orgId)
  const defaultStart = startOfMonth(today)
  const requestedStart = pickString(sp.periodStart)
  const requestedEnd = pickString(sp.periodEnd)
  const start = requestedStart && DATE.test(requestedStart) ? requestedStart : defaultStart
  const startBasedEnd = addCalendarDays(addCalendarMonthsStart(start, 3), -1)
  const end = requestedEnd && DATE.test(requestedEnd) && requestedEnd >= start ? requestedEnd : startBasedEnd
  const requestedOwner = pickString(sp.owner)
  const requestedTeam = pickString(sp.team)
  const ownerUserId = requestedOwner && isUuid(requestedOwner) ? requestedOwner : null
  // Owner and team are intentionally exclusive. The client filters clear the
  // opposite key; owner wins for manually constructed URLs containing both.
  const salesTeamId = !ownerUserId && requestedTeam && isUuid(requestedTeam) ? requestedTeam : null

  const [forecast, quotasResult, snapshotsResult, ownersResult, teamsResult] = (await Promise.all([
    calculateForecast({
      orgId: authz.user.orgId,
      periodStart: start,
      periodEnd: end,
      ownerUserId,
      salesTeamId,
    }),
    db.execute(sql`
      select q.*, u.name owner_name, st.name team_name
        from crm_sales_quotas q
        left join users u on u.id = q.owner_user_id
        left join crm_sales_teams st on st.id = q.sales_team_id and st.org_id = q.org_id
       where q.org_id = ${authz.user.orgId}
         and q.period_start <= ${end}::date
         and q.period_end >= ${start}::date
         ${ownerUserId ? sql`and q.owner_user_id = ${ownerUserId}` : sql``}
         ${salesTeamId ? sql`and q.sales_team_id = ${salesTeamId}` : sql``}
       order by q.period_start desc, coalesce(u.name, st.name), q.currency
    `),
    db.execute(sql`
      select s.*, u.name owner_name, st.name team_name
        from crm_forecast_snapshots s
        left join users u on u.id = s.owner_user_id
        left join crm_sales_teams st on st.id = s.sales_team_id and st.org_id = s.org_id
       where s.org_id = ${authz.user.orgId}
         and s.period_start = ${start}::date
         and s.period_end = ${end}::date
         ${ownerUserId ? sql`and s.owner_user_id = ${ownerUserId}` : sql``}
         ${salesTeamId ? sql`and s.sales_team_id = ${salesTeamId}` : sql``}
       order by s.as_of desc
       limit 50
    `),
    db.execute(sql`
      select id, name from users
       where org_id = ${authz.user.orgId} and is_active
       order by name
    `),
    db.execute(sql`
      select id, name from crm_sales_teams
       where org_id = ${authz.user.orgId} and is_active
       order by name
    `),
  ])) as any[]

  const quotas = quotasResult.rows as QuotaRow[]
  const snapshots = snapshotsResult.rows as SnapshotRow[]
  const canManageForecasts = can(authz, 'crm.forecasts.manage')
  const canConfigureQuotas = can(authz, 'crm.setup.manage')
  const snapshotAction = canManageForecasts ? (
    <ForecastSnapshotButton periodStart={start} periodEnd={end} ownerUserId={ownerUserId} salesTeamId={salesTeamId} />
  ) : null

  const actions = (
    <>
      {canConfigureQuotas ? (
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/setup/crm?tab=quotas" aria-label={t('forecasts.manageQuotas')}>
            <Settings2 size={15} />
            <span className="hidden sm:inline">{t('forecasts.manageQuotas')}</span>
          </Link>
        </Button>
      ) : null}
      {snapshotAction}
    </>
  )

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader title={t('forecasts.title')} description={t('forecasts.description')} actions={actions} />
          <div className="flex flex-wrap items-center gap-2">
            <DateRangeFilter
              fromKey="periodStart"
              toKey="periodEnd"
              fromLabel={t('fields.periodStart')}
              toLabel={t('fields.periodEnd')}
              defaultFrom={start}
              defaultTo={end}
              clearable={false}
            />
            <SearchSelectFilter
              paramKey="owner"
              label={t('fields.owner')}
              options={ownersResult.rows.map((row: { id: string; name: string }) => ({
                value: row.id,
                label: row.name,
              }))}
              resetParamKeys={['team']}
              className="w-full sm:w-48"
            />
            <SearchSelectFilter
              paramKey="team"
              label={t('fields.salesTeam')}
              options={teamsResult.rows.map((row: { id: string; name: string }) => ({
                value: row.id,
                label: row.name,
              }))}
              resetParamKeys={['owner']}
              className="w-full sm:w-48"
            />
          </div>
        </>
      }
    >
      <div className="space-y-6">
        <section aria-labelledby="forecast-summary-heading" className="space-y-3">
          <SectionHeading id="forecast-summary-heading" icon={<Gauge size={17} />} title={t('forecasts.summary')} />
          {(forecast as ForecastRow[]).length ? (
            <div className="space-y-4">
              {(forecast as ForecastRow[]).map((row) => (
                <div key={row.currency} className="space-y-2">
                  <Badge variant="secondary">{row.currency}</Badge>
                  <KpiStrip
                    items={[
                      {
                        label: t('forecasts.pipeline'),
                        value: money(row.pipeline_amount, {
                          currency: row.currency,
                        }),
                      },
                      {
                        label: t('forecasts.weighted'),
                        value: money(row.weighted_amount, {
                          currency: row.currency,
                        }),
                      },
                      {
                        label: t('forecastCategories.worst_case'),
                        value: money(row.worst_case_amount, {
                          currency: row.currency,
                        }),
                      },
                      {
                        label: t('forecasts.mostLikely'),
                        value: money(row.most_likely_amount, {
                          currency: row.currency,
                        }),
                      },
                      {
                        label: t('forecastCategories.upside'),
                        value: money(row.upside_amount, {
                          currency: row.currency,
                        }),
                      },
                      {
                        label: t('forecasts.closed'),
                        value: money(row.closed_amount, {
                          currency: row.currency,
                        }),
                        tone: 'good',
                      },
                    ]}
                  />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Gauge />}
              title={t('forecasts.emptyForecastTitle')}
              description={t('forecasts.emptyForecastDescription')}
            />
          )}
        </section>

        <section aria-labelledby="quota-heading" className="space-y-3">
          <SectionHeading id="quota-heading" icon={<Gauge size={17} />} title={t('forecasts.quotas')} />
          {quotas.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('forecasts.target')}</TableHead>
                  <TableHead>{t('fields.periodStart')}</TableHead>
                  <TableHead>{t('fields.periodEnd')}</TableHead>
                  <TableHead className="text-right">{t('forecasts.quota')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {quotas.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium text-slate-900 dark:text-slate-100">
                      {row.owner_name ?? row.team_name ?? '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatDate(row.period_start, locale)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatDate(row.period_end, locale)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {money(row.amount, { currency: row.currency })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon={<Gauge />}
              title={t('forecasts.emptyQuotaTitle')}
              description={t('forecasts.emptyQuotaDescription')}
              action={
                canConfigureQuotas ? (
                  <Button size="sm" asChild>
                    <Link href="/admin/setup/crm?tab=quotas">{t('forecasts.manageQuotas')}</Link>
                  </Button>
                ) : undefined
              }
            />
          )}
        </section>

        <section aria-labelledby="history-heading" className="space-y-3">
          <SectionHeading
            id="history-heading"
            icon={<History size={17} />}
            title={t('forecasts.history')}
            description={t('forecasts.snapshotCount', {
              count: snapshots.length,
            })}
          />
          {snapshots.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('forecasts.asOf')}</TableHead>
                  <TableHead>{t('forecasts.target')}</TableHead>
                  <TableHead>{t('forecasts.snapshotType')}</TableHead>
                  <TableHead>{t('fields.currency')}</TableHead>
                  <TableHead className="text-right">{t('forecasts.pipeline')}</TableHead>
                  <TableHead className="text-right">{t('forecasts.weighted')}</TableHead>
                  <TableHead className="text-right">{t('forecasts.mostLikely')}</TableHead>
                  <TableHead className="text-right">{t('forecasts.closed')}</TableHead>
                  <TableHead className="text-right">{t('forecasts.override')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshots.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(row.as_of))}
                    </TableCell>
                    <TableCell className="font-medium text-slate-900 dark:text-slate-100">
                      {row.owner_name ?? row.team_name ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={snapshotBadge(row.snapshot_kind)}>
                        {t(`forecasts.snapshotKinds.${row.snapshot_kind}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>{row.currency}</TableCell>
                    <MoneyCell value={row.pipeline_amount} currency={row.currency} format={money} />
                    <MoneyCell value={row.weighted_amount} currency={row.currency} format={money} />
                    <MoneyCell value={row.most_likely_amount} currency={row.currency} format={money} />
                    <MoneyCell value={row.closed_amount} currency={row.currency} format={money} />
                    <MoneyCell value={row.override_amount} currency={row.currency} format={money} />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon={<Camera />}
              title={t('forecasts.emptyHistoryTitle')}
              description={t('forecasts.emptyHistoryDescription')}
              action={snapshotAction ?? undefined}
            />
          )}
        </section>
      </div>
    </ListPageLayout>
  )
}

function SectionHeading({
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

function MoneyCell({
  value,
  currency,
  format,
}: {
  value: string | null
  currency: string
  format: (value: string, options?: { currency?: string }) => string
}) {
  return (
    <TableCell className="whitespace-nowrap text-right tabular-nums">
      {value === null ? '—' : format(value, { currency })}
    </TableCell>
  )
}

function snapshotBadge(kind: SnapshotRow['snapshot_kind']): 'outline' | 'default' | 'warning' {
  if (kind === 'manager_override') return 'warning'
  if (kind === 'rep_override') return 'default'
  return 'outline'
}

function formatDate(value: string | Date, locale: string) {
  const date = value instanceof Date ? value : new Date(`${value}T00:00:00`)
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date)
}
