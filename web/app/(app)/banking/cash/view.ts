import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission, can } from '../../../../lib/authz'
import { analyticsConfig } from '../../../../lib/analytics/config'
import { normalizeMoneyValue, withoutWeekEntries, resolveAsOf } from '../../../../lib/cash/core'
import { cashPosition, type CashPosition } from '../../../../lib/cash/cash-position'
import { reportSubsidiaryView } from '../../../../lib/consolidation'
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

  const parsed = Number(sp.horizon)
  const horizon = parsed === 4 || parsed === 12 ? parsed : 8

  // Subsidiary context (multi-subsidiary orgs): the whole cockpit — cash,
  // open items, SQL-backed forecast categories — scopes to the selected view.
  const subId = typeof sp.sub === 'string' ? sp.sub : undefined
  const asOfIso = await resolveAsOf(authz.user.orgId)
  const subView = await reportSubsidiaryView(subId, asOfIso)

  const cfg = await analyticsConfig(authz.user.orgId, 'cashflow')
  const apSettings = { weeklyCap: normalizeMoneyValue(String(cfg.weeklyApCap ?? 0)), restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1 }
  const [position, layoutPrefs] = await Promise.all([
    cashPosition(authz.user.orgId, horizon, apSettings, undefined, subView.subsidiary?.ids, authz.allowedSubsidiaryIds),
    userPageLayout(authz.user.id, 'banking-cash'),
  ])
  // Every week's totals and counts travel with the page; the transactions
  // behind them do not. On a real ledger those arrays are the entire open-item
  // book repeated across the horizon — tens of megabytes to render a timeline
  // whose rows show amounts. The week flyout fetches the week actually opened
  // from /api/cash/week-entries, at full detail.
  const data = { ...position, weeks: withoutWeekEntries(position.weeks) }

  const subQs = subId ? `?sub=${subId}` : ''

  return {
    title: t('title'),
    description: t('description'),
    subsidiaryPicker: subView.picker,
    subsidiaryValue: subView.picker.find((p) => p.id === subId)?.id ?? subView.picker[0]?.id ?? '',
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
      widgetBlock('cash-cockpit', {
        data: data.data,
        layoutPrefs: data.layoutPrefs,
        canConfigure: data.canConfigure,
        canPayRun: data.canPayRun,
        canCollectionRun: data.canCollectionRun,
      }),
    ],
  })
}
