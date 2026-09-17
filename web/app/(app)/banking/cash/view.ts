import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission, can } from '../../../../lib/authz'
import { analyticsConfig } from '../../../../lib/analytics/config'
import { normalizeCashHorizonWeeks, normalizeMoneyValue, withoutWeekEntries, resolveAsOf } from '../../../../lib/cash/core'
import { cashPosition, type CashPosition } from '../../../../lib/cash/cash-position'
import { MissingRatesError, reportSubsidiaryView, type RatesBlockedNotice } from '../../../../lib/consolidation'
import { userPageLayout } from '../../../../lib/page-layout'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import type { PageLayoutPrefs } from '@openbooks/schema'

/**
 * The cash control center, split into a loader and a spec.
 *
 * The body is one client cockpit — a horizon switcher, a vitals strip, a
 * negative-cash alert, five user-reorderable panels (weekly timeline with a
 * per-transaction flyout, forecast + bridge charts, health vitals, bank
 * accounts) behind per-user show/hide/reorder prefs, and a forecast-config
 * drawer. Client navigation (horizon, layout persistence, flyout, drawer)
 * keeps it whole; the spec places it and binds the position the loader
 * already projected — the same division as the AR cockpit (see
 * ../../ar/view.ts).
 *
 * No sections.tsx: the cockpit renders its own panels directly (StatTile,
 * CockpitPanel, Vital, CashTimeline, Chart), not one-off markup the spec
 * could compose, so there is nothing to share back with page.tsx.
 */

type SubsidiaryPicker = Awaited<ReturnType<typeof reportSubsidiaryView>>['picker']
type Tabs = Awaited<ReturnType<typeof groupTabs>>

export interface BankingCashData {
  title: string
  description: string
  subsidiaryPicker: SubsidiaryPicker
  subsidiaryValue: string
  subsidiaryLabel: string
  tabs: Tabs
  data: CashPosition
  /** Null unless the FX-rate pipeline blocked; the cockpit hides with it. */
  ratesBlocked: RatesBlockedNotice | null
  /** False exactly when ratesBlocked is set; the cockpit hides with it. */
  ratesReady: boolean
  layoutPrefs: PageLayoutPrefs
  canConfigure: boolean
  canPayRun: boolean
  canCollectionRun: boolean
}

export async function loadBankingCash(
  sp: Record<string, string | string[] | undefined>,
): Promise<BankingCashData> {
  const authz = await requirePermission('banking.read')
  const t = await getTranslations('banking.cash')
  const tBanking = await getTranslations('banking')

  const horizon = normalizeCashHorizonWeeks(sp.horizon, 8)

  // Subsidiary context (multi-subsidiary orgs): the whole cockpit — cash,
  // open items, SQL-backed forecast categories — scopes to the selected view.
  const subId = typeof sp.sub === 'string' ? sp.sub : undefined
  const asOfIso = await resolveAsOf(authz.user.orgId)
  // Fail closed when the FX-rate pipeline is blocked: the cockpit forecast is
  // an FX-bearing projection, so the loader reports `ratesBlocked` and the
  // page renders the shared typed banner instead of the cockpit.
  const tr = await getTranslations('reports')
  let subView: Awaited<ReturnType<typeof reportSubsidiaryView>> | undefined
  let ratesBlocked: RatesBlockedNotice | null = null
  try {
    subView = await reportSubsidiaryView(subId, asOfIso)
  } catch (error) {
    if (!(error instanceof MissingRatesError)) throw error
    ratesBlocked = {
      code: 'rates-not-derived',
      title: tr('statement.ratesBlockedTitle'),
      description: (error as Error).message,
      deriveLabel: tr('statement.ratesBlockedAction'),
      deriveHref: '/close',
    }
  }

  const cfg = await analyticsConfig(authz.user.orgId, 'cashflow')
  const apSettings = { weeklyCap: normalizeMoneyValue(String(cfg.weeklyApCap ?? 0)), restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1 }
  // Never run the position scope-less: a missing view inherits the caller's
  // full allowed set, which would silently widen a blocked-rate response.
  const [position, layoutPrefs] = await Promise.all([
    subView
      ? cashPosition(
          authz.user.orgId,
          horizon,
          apSettings,
          undefined,
          subView.subsidiary?.ids,
          authz.allowedSubsidiaryIds,
          subView.subsidiary?.includeNullSubsidiary,
        )
      : null,
    userPageLayout(authz.user.id, 'banking-cash'),
  ])
  // Every week's totals and counts travel with the page; the transactions
  // behind them do not. On a real ledger those arrays are the entire open-item
  // book repeated across the horizon — tens of megabytes to render a timeline
  // whose rows show amounts. The week flyout fetches the week actually opened
  // from /api/cash/week-entries, at full detail.
  const emptyPosition: CashPosition = {
    asOf: asOfIso,
    horizonWeeks: horizon,
    startingCash: '0',
    bankAccounts: [],
    weeks: [],
    totalInflows: '0',
    totalOutflows: '0',
    netChange: '0',
    projectedEnd: '0',
    lowestCash: '0',
    lowestWeek: '',
    burnRate: '0',
    runwayWeeks: null,
    runwayStatus: 'healthy',
    deferredBeyondHorizon: '0',
    dso: 0,
    dpo: 0,
    arOutstanding: '0',
    apOutstanding: '0',
    arCoverage: null,
    categories: [],
    apSettings,
    vendorOptions: [],
    accountOptions: [],
  }
  const data = position
    ? { ...position, weeks: withoutWeekEntries(position.weeks) }
    : emptyPosition

  const subQs = subId ? `?sub=${subId}` : ''

  return {
    title: t('title'),
    description: t('description'),
    ratesBlocked,
    ratesReady: ratesBlocked === null,
    subsidiaryPicker: subView?.picker ?? [],
    subsidiaryValue: subView?.picker.find((p) => p.id === subId)?.id ?? subView?.picker[0]?.id ?? '',
    subsidiaryLabel: tBanking('home.subsidiary'),
    tabs: await groupTabs('banking', '/banking/cash', { subQs, orgId: authz.user.orgId }),
    data,
    layoutPrefs,
    canConfigure: can(authz, 'admin.setup.manage'),
    canPayRun: can(authz, 'ap.pay'),
    canCollectionRun: can(authz, 'ar.pay'),
  }
}

const f = ref<BankingCashData>()

export function bankingCashSpec(data: BankingCashData): PageSpec {
  return page({
    route: '/banking/cash',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-3',
        actions: [
          widget('subsidiary-switcher', {
            picker: data.subsidiaryPicker,
            value: data.subsidiaryValue,
            label: data.subsidiaryLabel,
          }),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          title: data.ratesBlocked?.title ?? '',
          description: data.ratesBlocked?.description,
          action: 'link-button',
          actionProps: {
            href: data.ratesBlocked?.deriveHref ?? '/close',
            label: data.ratesBlocked?.deriveLabel ?? '',
          },
        }),
        when: f('ratesBlocked'),
      },
      // One client island: the horizon switcher, vitals strip, alert banner,
      // reorderable panels and config drawer are client state and client
      // navigation a spec cannot name. The loader performed the cockpit's
      // server work (permission gates, subsidiary scoping, cash position,
      // layout-prefs fetch — capabilities the LOADER may hold) and passes
      // the results through as data; layout persistence rides the session
      // cookie inside the shared component, so no user id, org id or Authz
      // crosses the spec. The `cash-cockpit` widget
      // renders the shared CashCockpit over that data — a widget, not a
      // slot, because there is no capability left to re-derive.
      {
        ...widgetBlock('cash-cockpit', {
          data: data.data,
          layoutPrefs: data.layoutPrefs,
          canConfigure: data.canConfigure,
          canPayRun: data.canPayRun,
          canCollectionRun: data.canCollectionRun,
        }),
        // The cockpit forecast is an FX-bearing projection: hide it while
        // rates are blocked and show the banner above instead of zeros.
        when: f('ratesReady'),
      },
    ],
  })
}
