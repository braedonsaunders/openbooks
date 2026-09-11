import 'server-only'

import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
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
} from '@openbooks/viewspec'
import { getAuthz, can, assertCan } from '../../../lib/authz'
import { resolveNav } from '../../../lib/nav/resolve'
import { reportSubsidiaryView } from '../../../lib/consolidation'
import { resolveAsOf } from '../../../lib/cash/core'
import { purchasingHome, type VendorExposureRow } from '../../../lib/module-home/purchasing'
import { getMoneyFormatter } from '@/lib/money-server'
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

export interface PurchasingData {
  title: string
  description: string
  subsidiaryLabel: string
  subsidiaryPicker: SubsidiaryPicker
  subsidiaryValue: string
  tabs: Tabs
  vendorsLabel: string
  vendorsValue: string
  ordersEnabled: boolean
  expensesEnabled: boolean
  openPosLabel: string
  openPosValue: string
  openPosSub: string
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
  if (!['ap.read', 'parties.read'].some((p) => can(authz, p))) assertCan(authz, 'ap.read')
  const t = await getTranslations('purchasing')
  const tNav = await getTranslations('nav')

  const subView = await reportSubsidiaryView(sp.sub, await resolveAsOf(authz.user.orgId))
  const [data, navGroups] = await Promise.all([
    purchasingHome(authz.user.orgId, subView.subsidiary?.ids),
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
    ),
  ])

  const groupItems = navGroups.find((g) => g.id === 'purchasing')?.items ?? []
  const subQs = sp.sub ? `?sub=${sp.sub}` : ''
  const tabs = await groupTabs('purchasing', '/purchasing', { subQs, orgId: authz.user.orgId })

  const badgeFor = (href: string): DirectoryItem['badge'] => {
    switch (href) {
      case '/purchase-orders':
        return { value: String(data.badges.openPos), hint: t('home.directory.posHint', { value: moneyCompact(data.openPoValue) }) }
      case '/ap/bills':
        return {
          value: String(data.badges.openBills),
          hint: t('home.directory.billsHint', { overdue: moneyCompact(data.apOverdue) }),
          tone: data.apOverdue > 0 ? 'warning' : 'neutral',
        }
      case '/payments':
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
    subsidiaryLabel: t('home.subsidiary'),
    subsidiaryPicker: subView.picker,
    subsidiaryValue: subView.picker.find((p) => p.id === sp.sub)?.id ?? subView.picker[0]?.id ?? '',
    tabs,
    vendorsLabel: t('home.vitals.activeVendors'),
    vendorsValue: String(data.badges.vendors),
    ordersEnabled: data.ordersEnabled,
    expensesEnabled: data.expensesEnabled,
    openPosLabel: t('home.vitals.openPos'),
    openPosValue: moneyCompact(data.openPoValue),
    openPosSub: t('home.vitals.openPosSub', { count: data.openPos }),
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
    apOverdueIsNegative: data.apOverdue > 0,
    apHref: `/ap${subQs}`,
    trendTitle: t('home.trend.title'),
    trendHint: t('home.trend.hint'),
    trendLabels: data.trend.map((w) => weekLabel(w.weekStart)),
    trendSeries: [{ name: t('home.trend.series'), data: data.trend.map((w) => w.spend), color: '#ef4444' }],
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
  moneyCompact: (value: number) => string,
): AttentionItem[] {
  const items: AttentionItem[] = []
  for (const r of exposure) {
    if (r.overdue > 0) {
      items.push({
        tone: r.overdue > r.billedOpen / 2 ? 'negative' : 'warning',
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

export function weekLabel(weekStart: string): string {
  return new Date(weekStart + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

const f = ref<PurchasingData>()

export function purchasingSpec(data: PurchasingData): PageSpec {
  return page({
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
      grid('flex h-full min-h-0 flex-col gap-4', [
        // Vitals strip. Two tiles are feature-gated; `when` expresses that
        // without the spec gaining a conditional.
        grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5', [
          statTile({ iconKey: 'building', accent: 'teal', label: f('vendorsLabel'), value: f('vendorsValue') }),
          statTile({
            iconKey: 'clipboard',
            accent: 'violet',
            label: f('openPosLabel'),
            value: f('openPosValue'),
            sub: f('openPosSub'),
            when: f('ordersEnabled'),
          }),
          statTile({
            iconKey: 'trending-up',
            accent: 'sky',
            label: f('spend30dLabel'),
            value: f('spend30dValue'),
            sub: f('spend30dSub'),
          }),
          statTile({
            iconKey: 'check-circle',
            accent: 'emerald',
            label: f('paymentsWeekLabel'),
            value: f('paymentsWeekValue'),
            sub: f('paymentsWeekSub'),
            tone: 'positive',
          }),
          statTile({
            iconKey: 'triangle-alert',
            accent: 'amber',
            label: f('unpostedLabel'),
            value: f('unpostedValue'),
            sub: f('unpostedSub'),
            tone: f('unpostedTone'),
            when: f('expensesEnabled'),
          }),
        ]),

        grid('grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3', [
          panel({
            title: f('heroTitle'),
            iconKey: 'building',
            hint: f('heroHint'),
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            className: 'min-h-[24rem] lg:col-span-2',
            blocks: [
              // The empty state lives inside the section component, not as a
              // negated conditional pair of blocks — see ./sections.
              widgetBlock('commitments-section', {
                rows: data.topExposure,
                showPurchaseOrders: data.ordersEnabled,
                empty: data.heroEmpty,
              }),
            ],
          }),

          grid('flex min-h-0 flex-col gap-5 overflow-y-auto', [
            panel({
              title: f('pulseTitle'),
              iconKey: 'gauge',
              bodyClassName: 'p-0',
              className: 'shrink-0',
              blocks: [
                widgetBlock('ap-pulse', {
                  outstanding: data.apOutstanding,
                  overdue: data.apOverdue,
                  dueNext7: data.dueNext7,
                  overdueIsNegative: data.apOverdueIsNegative,
                  labels: data.pulseLabels,
                  href: data.apHref,
                }),
              ],
            }),
            panel({
              title: f('trendTitle'),
              iconKey: 'area-chart',
              hint: f('trendHint'),
              className: 'shrink-0',
              blocks: [
                widgetBlock('trend-chart', {
                  labels: data.trendLabels,
                  series: data.trendSeries,
                  height: 170,
                  area: true,
                }),
              ],
            }),
            widgetBlock('directory-section', { items: data.directory, title: data.directoryTitle }),
            panel({
              title: f('attentionTitle'),
              iconKey: 'triangle-alert',
              bodyClassName: 'p-0',
              className: 'shrink-0',
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
