import 'server-only'

import { getLocale, getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  badge,
  column,
  field,
  frame,
  grid,
  money,
  page,
  pageHeader,
  ref,
  repeat,
  rootRef,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { addCalendarDays, addCalendarMonthsStart, businessToday, startOfMonth, isIsoCalendarDate } from '@openbooks/engine/src/business-date.ts'
import { can, requirePermission } from '../../../../lib/authz'
import { calculateForecast, type ForecastRow } from '../../../../lib/crm'
import { isUuid, pickString } from '../../../../lib/list-params'
import { getMoneyFormatter } from '../../../../lib/money-server'

/**
 * Forecasts and quotas, split into a loader and a spec.
 *
 * The filter row is three widgets, not filter-bar controls: the shared
 * report filter bar speaks `from`/`to` + period presets, while this page
 * writes explicit `periodStart`/`periodEnd` ISO dates and pairs two mutually
 * exclusive search-selects (owner clears team and vice versa). Re-expressing
 * those as generic controls would change the URL contract, so the spec places
 * the same components the native page uses.
 *
 * Each of the three sections is a `forecast-section` frame: the native
 * `<section aria-labelledby>` wrapper plus its icon heading is one-off chrome
 * the grid vocabulary cannot name (no aria attributes, no ids, no icon
 * components), while the tables inside stay real table blocks. The
 * per-currency KPI groups are a repeat over a KpiStrip widget — stat-tile
 * would re-derive that component badly.
 *
 * The quota table's target cell and the snapshot override cell are plain
 * text/money cells, not widgets. The native target is a styled `<td>` whose
 * em-dash fallback is inline text (the cell renderer's own fallback path
 * renders a styled span instead), so the loader pre-resolves '—' into the
 * field. The MoneyCell null-override branch is likewise resolved in the
 * loader for the same reason: a money cell with no widget wrapper.
 */

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

export interface ForecastKpiItem {
  label: string
  value: string
  tone?: 'good'
}

export interface ForecastCurrencyGroup {
  key: string
  currency: string
  items: ForecastKpiItem[]
}

export interface QuotaRowView {
  id: string
  target: string
  periodStart: string
  periodEnd: string
  quota: string
}

export interface SnapshotRowView {
  id: string
  asOf: string
  target: string
  kindLabel: string
  kindVariant: 'outline' | 'default' | 'warning'
  currency: string
  pipeline: string
  weighted: string
  mostLikely: string
  closed: string
  /** The loader renders the em-dash for a null override, so the cell is bare text either way. */
  override: string
}

export interface ForecastsData {
  title: string
  description: string
  canConfigureQuotas: boolean
  canManageForecasts: boolean
  manageQuotasHref: string
  manageQuotasLabel: string
  manageQuotasAriaLabel: string
  snapshotPeriodStart: string
  snapshotPeriodEnd: string
  snapshotOwnerUserId: string | null
  snapshotTeamId: string | null
  periodStartLabel: string
  periodEndLabel: string
  defaultStart: string
  defaultEnd: string
  ownerLabel: string
  ownerOptions: { value: string; label: string }[]
  teamLabel: string
  teamOptions: { value: string; label: string }[]
  summaryTitle: string
  quotasTitle: string
  historyTitle: string
  historyDescription: string
  hasForecast: boolean
  noForecast: boolean
  currencyGroups: ForecastCurrencyGroup[]
  emptyForecastTitle: string
  emptyForecastDescription: string
  hasQuotas: boolean
  noQuotas: boolean
  quotaRows: QuotaRowView[]
  columnTarget: string
  columnQuota: string
  emptyQuotaTitle: string
  emptyQuotaDescription: string
  quotaEmptyAction: string | null
  quotaEmptyActionProps: { href: string; label: string; size: string }
  hasSnapshots: boolean
  noSnapshots: boolean
  snapshotRows: SnapshotRowView[]
  columnAsOf: string
  columnType: string
  columnCurrency: string
  columnPipeline: string
  columnWeighted: string
  columnMostLikely: string
  columnClosed: string
  columnOverride: string
  emptyHistoryTitle: string
  emptyHistoryDescription: string
  historyEmptyAction: string | null
  historyEmptyActionProps: {
    periodStart: string
    periodEnd: string
    ownerUserId: string | null
    salesTeamId: string | null
  }
}

export async function loadForecasts(
  sp: Record<string, string | string[] | undefined>,
): Promise<ForecastsData> {
  const authz = await requirePermission('crm.forecasts.read')
  const [t, locale, { money }] = await Promise.all([
    getTranslations('crm'),
    getLocale(),
    getMoneyFormatter(authz.user.orgId),
  ])
  const today = await businessToday(authz.user.orgId)
  const defaultStart = startOfMonth(today)
  const requestedStart = pickString(sp.periodStart)
  const requestedEnd = pickString(sp.periodEnd)
  const start = requestedStart && isIsoCalendarDate(requestedStart) ? requestedStart : defaultStart
  const startBasedEnd = addCalendarDays(addCalendarMonthsStart(start, 3), -1)
  const end = requestedEnd && isIsoCalendarDate(requestedEnd) && requestedEnd >= start ? requestedEnd : startBasedEnd
  const requestedOwner = pickString(sp.owner)
  const requestedTeam = pickString(sp.team)
  const ownerUserId = requestedOwner && isUuid(requestedOwner) ? requestedOwner : null
  // Owner and team are intentionally exclusive. The client filters clear the
  // opposite key; owner wins for manually constructed URLs containing both.
  const salesTeamId = !ownerUserId && requestedTeam && isUuid(requestedTeam) ? requestedTeam : null

  const [forecast, quotasResult, snapshotsResult, ownersResult, teamsResult] = await Promise.all([
    calculateForecast({
      orgId: authz.user.orgId,
      periodStart: start,
      periodEnd: end,
      ownerUserId,
      salesTeamId,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    }),
    db.execute<QuotaRow>(sql`
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
    db.execute<SnapshotRow>(sql`
      select s.*, u.name owner_name, st.name team_name
        from crm_forecast_snapshots s
        left join users u on u.id = s.owner_user_id
        left join crm_sales_teams st on st.id = s.sales_team_id and st.org_id = s.org_id
       where s.org_id = ${authz.user.orgId} and ${authz.allowedSubsidiaryIds === null}
         and s.period_start = ${start}::date
         and s.period_end = ${end}::date
         ${ownerUserId ? sql`and s.owner_user_id = ${ownerUserId}` : sql``}
         ${salesTeamId ? sql`and s.sales_team_id = ${salesTeamId}` : sql``}
       order by s.as_of desc
       limit 50
    `),
    db.execute<{ id: string; name: string }>(sql`
      select id, name from users
       where org_id = ${authz.user.orgId} and is_active
       order by name
    `),
    db.execute<{ id: string; name: string }>(sql`
      select id, name from crm_sales_teams
       where org_id = ${authz.user.orgId} and is_active
       order by name
    `),
  ])

  const quotas = quotasResult.rows
  const snapshots = snapshotsResult.rows
  const canManageForecasts = authz.allowedSubsidiaryIds === null && can(authz, 'crm.forecasts.manage')
  const canConfigureQuotas = can(authz, 'crm.setup.manage')

  const pipelineLabel = t('forecasts.pipeline')
  const weightedLabel = t('forecasts.weighted')
  const mostLikelyLabel = t('forecasts.mostLikely')
  const closedLabel = t('forecasts.closed')

  return {
    title: t('forecasts.title'),
    description: t('forecasts.description'),
    canConfigureQuotas,
    canManageForecasts,
    manageQuotasHref: '/admin/setup/crm?tab=quotas',
    manageQuotasLabel: t('forecasts.manageQuotas'),
    manageQuotasAriaLabel: t('forecasts.manageQuotas'),
    snapshotPeriodStart: start,
    snapshotPeriodEnd: end,
    snapshotOwnerUserId: ownerUserId,
    snapshotTeamId: salesTeamId,
    periodStartLabel: t('fields.periodStart'),
    periodEndLabel: t('fields.periodEnd'),
    defaultStart: start,
    defaultEnd: end,
    ownerLabel: t('fields.owner'),
    ownerOptions: ownersResult.rows.map((row: { id: string; name: string }) => ({
      value: row.id,
      label: row.name,
    })),
    teamLabel: t('fields.salesTeam'),
    teamOptions: teamsResult.rows.map((row: { id: string; name: string }) => ({
      value: row.id,
      label: row.name,
    })),
    summaryTitle: t('forecasts.summary'),
    quotasTitle: t('forecasts.quotas'),
    historyTitle: t('forecasts.history'),
    historyDescription: t('forecasts.snapshotCount', { count: snapshots.length }),
    hasForecast: forecast.length > 0,
    noForecast: forecast.length === 0,
    currencyGroups: forecast.map((row) => ({
      key: row.currency,
      currency: row.currency,
      items: [
        { label: pipelineLabel, value: money(row.pipeline_amount, { currency: row.currency }) },
        { label: weightedLabel, value: money(row.weighted_amount, { currency: row.currency }) },
        {
          label: t('forecastCategories.worst_case'),
          value: money(row.worst_case_amount, { currency: row.currency }),
        },
        {
          label: mostLikelyLabel,
          value: money(row.most_likely_amount, { currency: row.currency }),
        },
        {
          label: t('forecastCategories.upside'),
          value: money(row.upside_amount, { currency: row.currency }),
        },
        {
          label: closedLabel,
          value: money(row.closed_amount, { currency: row.currency }),
          tone: 'good' as const,
        },
      ],
    })),
    emptyForecastTitle: t('forecasts.emptyForecastTitle'),
    emptyForecastDescription: t('forecasts.emptyForecastDescription'),
    hasQuotas: quotas.length > 0,
    noQuotas: quotas.length === 0,
    quotaRows: quotas.map((row) => ({
      id: row.id,
      target: row.owner_name ?? row.team_name ?? '—',
      periodStart: formatDate(row.period_start, locale),
      periodEnd: formatDate(row.period_end, locale),
      quota: money(row.amount, { currency: row.currency }),
    })),
    columnTarget: t('forecasts.target'),
    columnQuota: t('forecasts.quota'),
    emptyQuotaTitle: t('forecasts.emptyQuotaTitle'),
    emptyQuotaDescription: t('forecasts.emptyQuotaDescription'),
    quotaEmptyAction: canConfigureQuotas ? 'quota-empty-action' : null,
    quotaEmptyActionProps: {
      href: '/admin/setup/crm?tab=quotas',
      label: t('forecasts.manageQuotas'),
      size: 'sm',
    },
    hasSnapshots: snapshots.length > 0,
    noSnapshots: snapshots.length === 0,
    snapshotRows: snapshots.map((row) => ({
      id: row.id,
      asOf: new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(row.as_of)),
      target: row.owner_name ?? row.team_name ?? '—',
      kindLabel: t(`forecasts.snapshotKinds.${row.snapshot_kind}`),
      kindVariant: snapshotBadge(row.snapshot_kind),
      currency: row.currency,
      pipeline: money(row.pipeline_amount, { currency: row.currency }),
      weighted: money(row.weighted_amount, { currency: row.currency }),
      mostLikely: money(row.most_likely_amount, { currency: row.currency }),
      closed: money(row.closed_amount, { currency: row.currency }),
      override: row.override_amount === null ? '—' : money(row.override_amount, { currency: row.currency }),
    })),
    columnAsOf: t('forecasts.asOf'),
    columnType: t('forecasts.snapshotType'),
    columnCurrency: t('fields.currency'),
    columnPipeline: pipelineLabel,
    columnWeighted: weightedLabel,
    columnMostLikely: mostLikelyLabel,
    columnClosed: closedLabel,
    columnOverride: t('forecasts.override'),
    emptyHistoryTitle: t('forecasts.emptyHistoryTitle'),
    emptyHistoryDescription: t('forecasts.emptyHistoryDescription'),
    historyEmptyAction: canManageForecasts ? 'forecast-snapshot-button' : null,
    historyEmptyActionProps: {
      periodStart: start,
      periodEnd: end,
      ownerUserId,
      salesTeamId,
    },
  }
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

const f = ref<ForecastsData>()
const item = field
const rootF = rootRef<ForecastsData>()

export function forecastsSpec(data: ForecastsData): PageSpec {
  return page({
    route: '/crm/forecasts',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [
          widget(
            'manage-quotas-button',
            {
              href: data.manageQuotasHref,
              label: data.manageQuotasLabel,
              ariaLabel: data.manageQuotasAriaLabel,
            },
            f('canConfigureQuotas'),
          ),
          widget(
            'forecast-snapshot-button',
            {
              periodStart: data.snapshotPeriodStart,
              periodEnd: data.snapshotPeriodEnd,
              ownerUserId: data.snapshotOwnerUserId,
              salesTeamId: data.snapshotTeamId,
            },
            f('canManageForecasts'),
          ),
        ],
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('date-range-filter', {
          fromKey: 'periodStart',
          toKey: 'periodEnd',
          fromLabel: data.periodStartLabel,
          toLabel: data.periodEndLabel,
          defaultFrom: data.defaultStart,
          defaultTo: data.defaultEnd,
          clearable: false,
        }),
        widgetBlock('search-select-filter', {
          paramKey: 'owner',
          label: data.ownerLabel,
          options: data.ownerOptions,
          resetParamKeys: ['team'],
          className: 'w-full sm:w-48',
        }),
        widgetBlock('search-select-filter', {
          paramKey: 'team',
          label: data.teamLabel,
          options: data.teamOptions,
          resetParamKeys: ['owner'],
          className: 'w-full sm:w-48',
        }),
      ]),
    ],
    body: [
      grid('space-y-6', [
        frame(
          'forecast-section',
          [
            widgetBlock('section-heading', {
              id: 'forecast-summary-heading',
              iconKey: 'gauge',
              title: data.summaryTitle,
            }),
            {
              ...repeat({
                items: f('currencyGroups'),
                itemKey: item('key'),
                className: 'space-y-4',
                unwrapped: true,
                blocks: [
                  widgetBlock('forecast-kpi-group', {
                    currency: item('currency'),
                    items: item('items'),
                  }),
                ],
              }),
              when: f('hasForecast'),
            },
            {
              ...widgetBlock('empty-state', {
                icon: 'gauge',
                title: data.emptyForecastTitle,
                description: data.emptyForecastDescription,
              }),
              when: f('noForecast'),
            },
          ],
          { labelledBy: 'forecast-summary-heading' },
        ),
        frame(
          'forecast-section',
          [
            widgetBlock('section-heading', {
              id: 'quota-heading',
              iconKey: 'gauge',
              title: data.quotasTitle,
            }),
            {
              ...table({
                variant: 'app',
                rows: f('quotaRows'),
                rowKey: item('id'),
                columns: [
                  column(rootF('columnTarget'), text(item('target')), {
                    className: 'font-medium text-slate-900 dark:text-slate-100',
                  }),
                  column(rootF('periodStartLabel'), text(item('periodStart')), {
                    className: 'whitespace-nowrap tabular-nums',
                  }),
                  column(rootF('periodEndLabel'), text(item('periodEnd')), {
                    className: 'whitespace-nowrap tabular-nums',
                  }),
                  column(rootF('columnQuota'), money(item('quota')), {
                    align: 'right',
                    className: 'font-medium tabular-nums',
                  }),
                ],
              }),
              when: f('hasQuotas'),
            },
            {
              ...widgetBlock('empty-state', {
                icon: 'gauge',
                title: data.emptyQuotaTitle,
                description: data.emptyQuotaDescription,
                action: data.quotaEmptyAction,
                actionProps: data.quotaEmptyActionProps,
              }),
              when: f('noQuotas'),
            },
          ],
          { labelledBy: 'quota-heading' },
        ),
        frame(
          'forecast-section',
          [
            widgetBlock('section-heading', {
              id: 'history-heading',
              iconKey: 'history',
              title: data.historyTitle,
              description: data.historyDescription,
            }),
            {
              ...table({
                variant: 'app',
                rows: f('snapshotRows'),
                rowKey: item('id'),
                columns: [
                  column(rootF('columnAsOf'), text(item('asOf')), {
                    className: 'whitespace-nowrap tabular-nums',
                  }),
                  column(rootF('columnTarget'), text(item('target')), {
                    className: 'font-medium text-slate-900 dark:text-slate-100',
                  }),
                  column(
                    rootF('columnType'),
                    badge(item('kindLabel'), { variant: item('kindVariant') }),
                  ),
                  column(rootF('columnCurrency'), text(item('currency'))),
                  column(rootF('columnPipeline'), money(item('pipeline')), {
                    align: 'right',
                    className: 'whitespace-nowrap',
                  }),
                  column(rootF('columnWeighted'), money(item('weighted')), {
                    align: 'right',
                    className: 'whitespace-nowrap',
                  }),
                  column(rootF('columnMostLikely'), money(item('mostLikely')), {
                    align: 'right',
                    className: 'whitespace-nowrap',
                  }),
                  column(rootF('columnClosed'), money(item('closed')), {
                    align: 'right',
                    className: 'whitespace-nowrap',
                  }),
                  column(rootF('columnOverride'), money(item('override')), {
                    align: 'right',
                    className: 'whitespace-nowrap',
                  }),
                ],
              }),
              when: f('hasSnapshots'),
            },
            {
              ...widgetBlock('empty-state', {
                icon: 'camera',
                title: data.emptyHistoryTitle,
                description: data.emptyHistoryDescription,
                action: data.historyEmptyAction,
                actionProps: data.historyEmptyActionProps,
              }),
              when: f('noSnapshots'),
            },
          ],
          { labelledBy: 'history-heading' },
        ),
      ]),
    ],
  })
}
