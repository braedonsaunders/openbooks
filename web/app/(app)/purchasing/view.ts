import { cmp, mulDecimal } from '@openbooks/engine/src/money/money.ts'
import 'server-only'

import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import {
  grid,
  page,
  pageHeader,
  panel,
  ref,
  statTile,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { getAuthz, can, assertCan } from '../../../lib/authz'
import { resolveNav } from '../../../lib/nav/resolve'
import { reportSubsidiaryScope, reportSubsidiaryView } from '../../../lib/consolidation'
import { resolveAsOf } from '../../../lib/cash/core'
import { purchasingHome, type VendorExposureRow } from '../../../lib/module-home/purchasing'
import { MissingRatesError, type RatesBlockedNotice } from '../../../lib/consolidation'
import { getMoneyFormatter } from '@/lib/money-server'
import { toChartNumber } from '../../../lib/chart-number'
import { trendWeekLabel } from '../../../lib/format'
import { groupTabs } from '../../../components/module-home/group-tabs'
import type { DirectoryItem } from '../../../components/module-home/ui'
import type { AttentionItem } from './sections'

/**
 * The purchasing cockpit, split into a loader and a spec.
 *
 * This archetype behaves differently from a list page, and the difference is
 * worth being explicit about. A list page decomposes cleanly into blocks; a
 * cockpit does not. Its rail sections are each a handful of one-off markup,
 * and inventing a block per section would grow the vocabulary one page at a
 * time forever. So the division here is: ViewSpec composes the GRID and the
 * PANELS; the panel bodies stay components, shared by the page and the widget registry via
 * ./sections so they cannot drift.
 *
 * That is a weaker claim than "the page is expressible" — but it is the honest
 * one, and it still buys the thing that matters: panels can be reordered,
 * hidden, or added by editing data rather than code.
 */

type SubsidiaryPicker = Awaited<ReturnType<typeof reportSubsidiaryView>>['picker']
type Tabs = Awaited<ReturnType<typeof groupTabs>>

/**
 * Lean scope recovery for a rates-blocked workspace: the refusal
 * carries no scope, so resolve it leniently like the banking overview — same
 * visibility, same picker rows, figures included. The home translates at
 * dated spot rates rather than period consolidated rates, so a dormant
 * foreign subsidiary with no derived rates must not zero a workspace whose
 * every figure is computable (SIM Meridian read 0 vendors / $0 spend / $0
 * payables beside an 'All clear' while holding 7 vendors and ~$125K of open
 * posted bills). The banner still pins beside live numbers; switching to a
 * single-subsidiary view clears it.
 */

export interface PurchasingData {
  title: string
  description: string
  /** False when the caller lacks ap.read: every AP-derived vital below is
   * omitted from the spec, never zero-shaped. */
  apAllowed: boolean
  /** ordersEnabled AND apAllowed: the open-PO tile carries PO money, so it
   * needs both the feature and the AP grant (`when` takes a single ref). */
  posAllowed: boolean
  /** Per-section grants from the loader: tiles hide where the grant is missing. */
  grants: { ap: boolean; orders: boolean; expenses: boolean; parties: boolean }
  subsidiaryLabel: string
  subsidiaryPicker: SubsidiaryPicker
  subsidiaryValue: string
  /** Set when underived consolidated rates block the workspace:
   * the page renders a typed banner with a derive link above empty vitals. */
  ratesBlocked: RatesBlockedNotice | null
  tabs: Tabs
  vendorsLabel: string
  vendorsValue: string
  ordersEnabled: boolean
  expensesEnabled: boolean
  openPosLabel: string
  openPosValue: string
  openPosSub: string
  openApLabel: string
  overdueLabel: string
  spend30dLabel: string
  spend30dValue: string
  spend30dSub: string
  paymentsWeekLabel: string
  paymentsWeekValue: string
  paymentsWeekSub: string
  unpostedLabel: string
  unpostedValue: string
  unpostedSub: string
  unpostedTone: 'warning' | 'positive'
  heroTitle: string
  heroHint: string
  heroEmpty: string
  /** Create action for the empty commitments hero: a purchase order where
   *  orders are on and the caller holds purchase_orders.create, otherwise a
   *  vendor bill where the caller holds ap.create. */
  heroEmptyAction: { href: string; label: string } | null
  topExposure: VendorExposureRow[]
  hasExposure: boolean
  pulseTitle: string
  pulseLabels: { open: string; overdue: string; due7: string; cta: string }
  apOutstanding: string
  apOverdue: string
  dueNext7: string
  apOverdueIsNegative: boolean
  apHref: string
  trendTitle: string
  trendHint: string
  trendLabels: string[]
  trendSeries: { name: string; data: number[]; color: string }[]
  directoryTitle: string
  directory: DirectoryItem[]
  attentionTitle: string
  attentionAllClear: string
  attention: AttentionItem[]
}

export async function loadPurchasing(
  sp: Record<string, string | undefined>,
): Promise<PurchasingData> {
  const { moneyCompact } = await getMoneyFormatter()
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  if (!['ap.read', 'purchase_orders.read', 'parties.read', 'expenses.read'].some((p) => can(authz, p))) assertCan(authz, 'ap.read')
  const t = await getTranslations('purchasing')
  const locale = await getLocale()
  const tNav = await getTranslations('nav')
  const tr = await getTranslations('reports')

  // Underived consolidated rates must not throw out of SSR:
  // the page renders a typed banner with a derive link above live vitals.
  // Anything else is a real defect and still throws. The home translates at
  // dated spot rates, so figures load through the lenient scope even while
  // the banner pins (same recovery as the banking overview).
  let subView: Awaited<ReturnType<typeof reportSubsidiaryView>> | undefined
  let ratesBlocked: RatesBlockedNotice | null = null
  try {
    subView = await reportSubsidiaryView(sp.sub, await resolveAsOf(authz.user.orgId))
  } catch (e) {
    if (!(e instanceof MissingRatesError)) throw e
    ratesBlocked = {
      code: 'rates-not-derived',
      title: tr('statement.ratesBlockedTitle'),
      description: (e as Error).message,
      deriveLabel: tr('statement.ratesBlockedAction'),
      deriveHref: '/close',
    }
    // The refusal carries no scope, so resolve it leniently: same
    // visibility, same picker rows (the switcher stays an escape to a
    // single-entity view), figures included.
    const scoped = await reportSubsidiaryScope(sp.sub, await resolveAsOf(authz.user.orgId))
    subView = {
      subsidiary: scoped.subsidiary,
      currency: scoped.currency,
      label: scoped.label,
      consolidated: scoped.consolidated,
      options: scoped.options,
      picker: scoped.picker,
    }
  }
  // The home spans the vendor directory (parties.read) and AP money
  // (ap.read): either opens the page, but every AP-derived figure keeps only
  // its own family's grant — a vendor-directory clerk loads no AP rows and
  // sees no AP vitals.
  const grants = {
    ap: can(authz, 'ap.read'),
    orders: can(authz, 'purchase_orders.read'),
    expenses: can(authz, 'expenses.read'),
    parties: can(authz, 'parties.read'),
  }
  const [data, navGroups] = await Promise.all([
    purchasingHome(
      authz.user.orgId,
      subView?.subsidiary?.ids,
      subView?.subsidiary?.includeNullSubsidiary,
      grants,
    ),
    resolveNav(
      authz.user.orgId,
      (permission) => permission === undefined || can(authz, permission),
      authz.user.roles.map(({ key }) => key),
      (key) => {
        try {
          return tNav(key)
        } catch {
          return ''
        }
      },
      (key) => {
        try {
          return tNav.has(key)
        } catch {
          return false
        }
      },
    ),
  ])

  const groupItems = navGroups.find((g) => g.id === 'purchasing')?.items ?? []
  const subQs = sp.sub ? `?sub=${sp.sub}` : ''
  const tabs = await groupTabs('purchasing', '/purchasing', { subQs, orgId: authz.user.orgId })

  // Directory links are already permission-filtered by resolveNav; the badge
  // VALUES need the same per-family grant, or an AP figure leaks beside an
  // allowed vendor-directory link.
  const badgeFor = (href: string): DirectoryItem['badge'] => {
    switch (href) {
      case '/purchase-orders':
        if (!grants.ap) return undefined
        return { value: String(data.badges.openPos), hint: t('home.directory.posHint', { value: moneyCompact(data.openPoValue) }) }
      case '/ap/bills':
        if (!grants.ap) return undefined
        return {
          value: String(data.badges.openBills),
          hint: t('home.directory.billsHint', { overdue: moneyCompact(data.apOverdue) }),
          tone: cmp(data.apOverdue, '0') > 0 ? 'warning' : 'neutral',
        }
      case '/payments':
        if (!grants.ap) return undefined
        return { value: String(data.badges.payments7d), hint: t('home.directory.paymentsHint') }
      case '/expenses/reports':
        return {
          value: String(data.badges.unpostedExpenses),
          hint: t('home.directory.expensesHint'),
          tone: data.badges.unpostedExpenses > 0 ? 'warning' : 'positive',
        }
      case '/entities/vendors':
        return { value: String(data.badges.vendors), hint: t('home.directory.vendorsHint') }
      default:
        return undefined
    }
  }

  const directory: DirectoryItem[] = groupItems
    .filter((i) => i.href !== '/purchasing' && i.href !== '/ap')
    .map((i) => ({ href: i.href, label: i.label, iconKey: i.iconKey, badge: badgeFor(i.href) }))

  const attention = needsAttention(
    data.topExposure,
    data.expensesEnabled ? data.badges.unpostedExpenses : 0,
    t,
    moneyCompact,
  )

  return {
    title: t('home.title'),
    description: t('home.description'),
    apAllowed: data.apAllowed,
    posAllowed: data.ordersEnabled && grants.ap,
    grants,
    subsidiaryLabel: t('home.subsidiary'),
    subsidiaryPicker: subView?.picker ?? [],
    subsidiaryValue: subView?.picker.find((p) => p.id === sp.sub)?.id ?? subView?.picker[0]?.id ?? '',
    ratesBlocked,
    tabs,
    vendorsLabel: t('home.vitals.activeVendors'),
    vendorsValue: String(data.badges.vendors),
    ordersEnabled: data.ordersEnabled,
    expensesEnabled: data.expensesEnabled,
    openPosLabel: t('home.vitals.openPos'),
    openPosValue: moneyCompact(data.openPoValue),
    openPosSub: t('home.vitals.openPosSub', { count: data.openPos }),
    openApLabel: t('home.vitals.openAp'),
    overdueLabel: t('home.vitals.overdue'),
    spend30dLabel: t('home.vitals.spend30d'),
    spend30dValue: moneyCompact(data.spend30d),
    spend30dSub: t('home.vitals.spend30dSub'),
    paymentsWeekLabel: t('home.vitals.paymentsWeek'),
    paymentsWeekValue: moneyCompact(data.badges.paid7dValue),
    paymentsWeekSub: t('home.vitals.paymentsWeekSub', { count: data.badges.payments7d }),
    unpostedLabel: t('home.vitals.unposted'),
    unpostedValue: String(data.badges.unpostedExpenses),
    unpostedSub: t('home.vitals.unpostedSub'),
    unpostedTone: data.badges.unpostedExpenses > 0 ? 'warning' : 'positive',
    heroTitle: t('home.hero.title'),
    heroHint: t('home.hero.hint'),
    heroEmpty: t('home.hero.empty'),
    // The empty hero names its prerequisite in copy; the action goes one
    // step further only where the caller holds the matching create grant —
    // a reader without it keeps the honest zero with no misleading button.
    heroEmptyAction: data.ordersEnabled && can(authz, 'purchase_orders.create')
      ? { href: '/purchase-orders?orderNew=1', label: t('home.hero.createOrder') }
      : can(authz, 'ap.create')
        ? { href: '/ap/bills?doc=new&kind=vendor_bill', label: t('home.hero.createBill') }
        : null,
    topExposure: data.topExposure,
    hasExposure: data.topExposure.length > 0,
    pulseTitle: t('home.pulse.title'),
    pulseLabels: {
      open: t('home.pulse.open'),
      overdue: t('home.pulse.overdue'),
      due7: t('home.pulse.due7'),
      cta: t('home.pulse.cta'),
    },
    apOutstanding: moneyCompact(data.apOutstanding),
    apOverdue: moneyCompact(data.apOverdue),
    dueNext7: moneyCompact(data.dueNext7),
    apOverdueIsNegative: cmp(data.apOverdue, '0') > 0,
    apHref: `/ap${subQs}`,
    trendTitle: t('home.trend.title'),
    trendHint: t('home.trend.hint'),
    trendLabels: data.trend.map((w) => trendWeekLabel(w.weekStart, locale)),
    // The chart boundary is the only place trend strings become numbers.
    trendSeries: [{ name: t('home.trend.series'), data: data.trend.map((w) => toChartNumber(w.spend)), color: '#ef4444' }],
    directoryTitle: t('home.directory.title'),
    directory,
    attentionTitle: t('home.attention.title'),
    attentionAllClear: t('home.attention.allClear'),
    attention,
  }
}

type T = Awaited<ReturnType<typeof getTranslations<'purchasing'>>>

export function needsAttention(
  exposure: VendorExposureRow[],
  unpostedExpenses: number,
  t: T,
  moneyCompact: (value: string | number) => string,
): AttentionItem[] {
  const items: AttentionItem[] = []
  for (const r of exposure) {
    if (cmp(r.overdue, '0') > 0) {
      items.push({
        tone: cmp(r.overdue, mulDecimal(r.billedOpen, '0.5')) > 0 ? 'negative' : 'warning',
        text: t('home.attention.overdueVendor', { vendor: r.name, amount: moneyCompact(r.overdue) }),
        href: '/ap',
      })
    }
  }
  if (unpostedExpenses > 0) {
    items.push({ tone: 'warning', text: t('home.attention.unpostedExpenses', { count: unpostedExpenses }), href: '/expenses/reports' })
  }
  return items.slice(0, 6)
}

const f = ref<PurchasingData>()

export function purchasingSpec(data: PurchasingData): PageSpec {
  return page({
    route: '/purchasing',
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
      widgetBlock('empty-state', {
        title: data.ratesBlocked?.title ?? '',
        description: data.ratesBlocked?.description,
        action: 'link-button',
        actionProps: {
          href: data.ratesBlocked?.deriveHref ?? '/close',
          label: data.ratesBlocked?.deriveLabel ?? '',
        },
      }, f('ratesBlocked')),
      grid('flex h-full min-h-0 flex-col gap-4', [
        // Optional capabilities use their own metrics while enabled. Otherwise
        // show payables metrics under the same AP read permission as the pulse.
        grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5', [
          statTile({ iconKey: 'building', accent: 'teal', label: f('vendorsLabel'), value: f('vendorsValue'), when: f('grants.parties') }),
          data.ordersEnabled ? statTile({
            iconKey: 'clipboard',
            accent: 'violet',
            label: f('openPosLabel'),
            value: f('openPosValue'),
            sub: f('openPosSub'),
            when: f('posAllowed'),
          }) : statTile({
            iconKey: 'wallet', accent: 'violet', label: f('openApLabel'),
            value: f('apOutstanding'), when: f('apAllowed'),
          }),
          statTile({
            iconKey: 'trending-up',
            accent: 'sky',
            label: f('spend30dLabel'),
            value: f('spend30dValue'),
            sub: f('spend30dSub'),
            when: f('apAllowed'),
          }),
          statTile({
            iconKey: 'check-circle',
            accent: 'emerald',
            label: f('paymentsWeekLabel'),
            value: f('paymentsWeekValue'),
            sub: f('paymentsWeekSub'),
            tone: 'positive',
            when: f('apAllowed'),
          }),
          data.expensesEnabled ? statTile({
            iconKey: 'triangle-alert',
            accent: 'amber',
            label: f('unpostedLabel'),
            value: f('unpostedValue'),
            sub: f('unpostedSub'),
            tone: f('unpostedTone'),
            when: f('expensesEnabled'),
          }) : statTile({
            iconKey: 'triangle-alert', accent: 'red', label: f('overdueLabel'),
            value: f('apOverdue'),
            tone: data.apOverdueIsNegative ? 'negative' : undefined, when: f('apAllowed'),
          }),
        ]),

        grid('grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3', [
          panel({
            title: f('heroTitle'),
            iconKey: 'building',
            hint: f('heroHint'),
            // Match the AR/AP worklist panels: fill the available grid height
            // and keep long tables scrollable inside the panel.
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            className: 'min-h-0 lg:col-span-2',
            // The roster carries per-vendor AP money: without ap.read the
            // whole panel is omitted, never an honest-looking zero hero.
            when: f('apAllowed'),
            blocks: [
              // The empty state lives inside the section component, not as a
              // negated conditional pair of blocks — see ./sections.
              widgetBlock('commitments-section', {
                rows: data.topExposure,
                showPurchaseOrders: data.ordersEnabled,
                empty: data.heroEmpty,
                emptyAction: data.heroEmptyAction,
              }),
            ],
          }),

          grid('flex min-h-0 flex-col gap-5 overflow-y-auto', [
            panel({
              title: f('pulseTitle'),
              iconKey: 'gauge',
              bodyClassName: 'p-0',
              className: 'shrink-0',
              when: f('apAllowed'),
              blocks: [
                widgetBlock('ap-pulse', {
                  outstanding: data.apOutstanding,
                  overdue: data.apOverdue,
                  dueNext7: data.dueNext7,
                  overdueIsNegative: data.apOverdueIsNegative,
                  labels: data.pulseLabels,
                  href: data.apHref,
                }, f('grants.ap')),
              ],
            }),
            panel({
              title: f('trendTitle'),
              iconKey: 'area-chart',
              hint: f('trendHint'),
              className: 'shrink-0',
              when: f('apAllowed'),
              blocks: [
                widgetBlock('trend-chart', {
                  labels: data.trendLabels,
                  series: data.trendSeries,
                  height: 170,
                  area: true,
                }, f('grants.ap')),
              ],
            }),
            widgetBlock('directory-section', { items: data.directory, title: data.directoryTitle }),
            panel({
              title: f('attentionTitle'),
              iconKey: 'triangle-alert',
              bodyClassName: 'p-0',
              className: 'shrink-0',
              when: f('grants.ap'),
              blocks: [
                widgetBlock('attention-list', {
                  items: data.attention,
                  allClear: data.attentionAllClear,
                }),
              ],
            }),
          ]),
        ]),
      ]),
    ],
  })
}
