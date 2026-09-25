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
import { reportSubsidiaryView } from '../../../lib/consolidation'
import { resolveAsOf } from '../../../lib/cash/core'
import { customersHome, type CustomerExposureRow, type CustomersHome } from '../../../lib/module-home/customers'
import { MissingRatesError, type RatesBlockedNotice } from '../../../lib/consolidation'
import { getMoneyFormatter } from '@/lib/money-server'
import { cmp, mulDecimal } from '@openbooks/engine/src/money/money.ts'
import { customerGroupTabs } from '../../../components/module-home/group-tabs'
import type { DirectoryItem } from '../../../components/module-home/ui'

/**
 * The customers cockpit, split into a loader and a spec.
 *
 * Same archetype as the purchasing cockpit: ViewSpec composes the GRID and
 * the PANELS; the panel bodies stay components, shared via ./sections so the
 * two render paths cannot drift. The rail's attention list and directory are
 * byte-identical to the existing `attention-list` and `directory-section`
 * registry widgets, so the spec reuses those and only the hero table and the
 * AR pulse need new registry entries.
 *
 * Loader logic is copied verbatim from page.tsx: the workspace spans CRM + AR
 * + records (any of the group's read permissions opens the home), panels stay
 * org-wide counts, and every money value is formatted with the organization's
 * base currency the same way the native page formats it.
 */

type SubsidiaryPicker = Awaited<ReturnType<typeof reportSubsidiaryView>>['picker']
type Tabs = Awaited<ReturnType<typeof customerGroupTabs>>

export interface CustomerAttentionItem {
  tone: 'negative' | 'warning'
  text: string
  href: string
}

/**
 * Fail-closed home figures for a rates-blocked workspace (F-t06-027): every
 * vital reads empty/zero and feature tiles hide, so nothing presents a
 * scoped number beside the banner. Navigation (tabs, directory, subsidiary
 * switcher) keeps working — switching to a single-subsidiary view loads
 * real figures.
 */
const BLOCKED_HOME: CustomersHome = {
  arOutstanding: '0.0000',
  arOverdue: '0.0000',
  openInvoices: 0,
  overdueInvoices: 0,
  activeCustomers: 0,
  dso: 0,
  pipeline: { total: '0.0000', weighted: '0.0000', closed: '0.0000' },
  topExposure: [],
  trend: [],
  badges: {
    openOpportunities: 0,
    openQuotes: 0,
    openSalesOrders: 0,
    receipts7d: 0,
    collected7d: '0.0000',
    customers: 0,
  },
  ordersEnabled: false,
  crmEnabled: false,
  // Rates-blocked keeps the existing empty-vitals render (F-t06-027): the
  // omission here is rates, not permission, so the allow flags stay open.
  arAllowed: true,
  partiesAllowed: true,
}

export interface CustomersData {
  title: string
  description: string
  subsidiaryLabel: string
  subsidiaryPicker: SubsidiaryPicker
  subsidiaryValue: string
  /** Set when underived consolidated rates block the workspace (F-t06-027):
   * the page renders a typed banner with a derive link above empty vitals. */
  ratesBlocked: RatesBlockedNotice | null
  tabs: Tabs
  activeCustomersLabel: string
  activeCustomersValue: string
  crmEnabled: boolean
  ordersEnabled: boolean
  /** I4-webui-225b: false hides every AR-derived vital (omitted, not zero). */
  arAllowed: boolean
  /** I4-webui-225b: false hides the directory and customer count. */
  partiesAllowed: boolean
  pipelineLabel: string
  pipelineValue: string
  pipelineSub: string
  closedQuarterLabel: string
  closedQuarterValue: string
  quotesOrdersLabel: string
  quotesOrdersValue: string
  quotesOrdersSub: string
  collectedWeekLabel: string
  collectedWeekValue: string
  collectedWeekSub: string
  heroTitle: string
  heroHint: string
  heroEmpty: string
  topExposure: CustomerExposureRow[]
  pulseTitle: string
  pulseLabels: { open: string; overdue: string; dso: string; cta: string }
  arOutstanding: string
  arOverdue: string
  arOverdueIsNegative: boolean
  dsoText: string
  arHref: string
  trendTitle: string
  trendHint: string
  trendLabels: string[]
  trendSeries: { name: string; data: number[]; color: string }[]
  directoryTitle: string
  directory: DirectoryItem[]
  attentionTitle: string
  attentionAllClear: string
  attention: CustomerAttentionItem[]
}

export async function loadCustomers(
  sp: Record<string, string | undefined>,
): Promise<CustomersData> {
  const { moneyCompact } = await getMoneyFormatter()
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  // The workspace spans CRM + AR + records — any of the group's read
  // permissions opens the home; every panel then keeps only its own
  // family's grant (I4-webui-225b). 'crm.read' stays admitted for
  // wildcard-era grants; the pipeline itself requires the granular
  // crm.opportunities.read its board source requires.
  if (!['ar.read', 'crm.read', 'crm.opportunities.read', 'parties.read'].some((p) => can(authz, p))) assertCan(authz, 'ar.read')
  const grants = {
    ar: can(authz, 'ar.read'),
    crm: can(authz, 'crm.opportunities.read'),
    parties: can(authz, 'parties.read'),
  }
  const t = await getTranslations('customers')
  const locale = await getLocale()
  const tNav = await getTranslations('nav')
  const tr = await getTranslations('reports')

  // Underived consolidated rates must not throw out of SSR (F-t06-027):
  // the page renders a typed banner with a derive link above empty vitals.
  // Anything else is a real defect and still throws. Home figures load only
  // with a resolved subsidiary scope — BLOCKED_HOME otherwise (fail-closed).
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
  }
  const [data, navGroups] = await Promise.all([
    subView
      ? customersHome(
          authz.user.orgId,
          subView.subsidiary?.ids,
          subView.subsidiary?.includeNullSubsidiary,
          grants,
        )
      : BLOCKED_HOME,
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

  const groupItems = navGroups.find((g) => g.id === 'customers')?.items ?? []
  const subQs = sp.sub ? `?sub=${sp.sub}` : ''
  const tabs = await customerGroupTabs(authz, '/customers', { subQs })

  // I4-webui-225b: directory links are already permission-filtered by
  // resolveNav; the badge VALUES need the same per-family grant, or a
  // count from an unreadable family leaks beside an allowed link.
  const badgeFor = (href: string): DirectoryItem['badge'] => {
    switch (href) {
      case '/crm/opportunities':
        if (!grants.crm) return undefined
        return { value: String(data.badges.openOpportunities), hint: t('home.directory.opportunitiesHint') }
      case '/estimates':
        if (!grants.ar) return undefined
        return { value: String(data.badges.openQuotes), hint: t('home.directory.estimatesHint') }
      case '/sales-orders':
        if (!grants.ar) return undefined
        return { value: String(data.badges.openSalesOrders), hint: t('home.directory.salesOrdersHint') }
      case '/ar/invoices':
        if (!grants.ar) return undefined
        return {
          value: String(data.openInvoices),
          hint: t('home.directory.invoicesHint', { overdue: data.overdueInvoices }),
          tone: data.overdueInvoices > 0 ? 'warning' : 'neutral',
        }
      case '/receipts':
        if (!grants.ar) return undefined
        return { value: String(data.badges.receipts7d), hint: t('home.directory.receiptsHint') }
      case '/entities/customers':
        if (!grants.parties) return undefined
        return { value: String(data.badges.customers), hint: t('home.directory.customersHint') }
      default:
        return undefined
    }
  }
  const directory: DirectoryItem[] = groupItems
    .filter((i) => i.href !== '/customers' && i.href !== '/ar')
    .map((i) => ({ href: i.href, label: i.label, iconKey: i.iconKey, badge: badgeFor(i.href) }))

  const attention = needsAttention(data.topExposure, t, moneyCompact)

  return {
    title: t('home.title'),
    description: t('home.description'),
    subsidiaryLabel: t('home.subsidiary'),
    subsidiaryPicker: subView?.picker ?? [],
    subsidiaryValue: subView?.picker.find((p) => p.id === sp.sub)?.id ?? subView?.picker[0]?.id ?? '',
    ratesBlocked,
    tabs,
    activeCustomersLabel: t('home.vitals.activeCustomers'),
    activeCustomersValue: String(data.activeCustomers),
    crmEnabled: data.crmEnabled,
    ordersEnabled: data.ordersEnabled,
    arAllowed: data.arAllowed,
    partiesAllowed: data.partiesAllowed,
    pipelineLabel: t('home.vitals.pipeline'),
    pipelineValue: moneyCompact(data.pipeline.total),
    pipelineSub: t('home.vitals.pipelineSub', { weighted: moneyCompact(data.pipeline.weighted) }),
    closedQuarterLabel: t('home.vitals.closedQuarter'),
    closedQuarterValue: moneyCompact(data.pipeline.closed),
    quotesOrdersLabel: t('home.vitals.quotesOrders'),
    quotesOrdersValue: String(data.badges.openQuotes + data.badges.openSalesOrders),
    quotesOrdersSub: t('home.vitals.quotesOrdersSub', {
      quotes: data.badges.openQuotes,
      orders: data.badges.openSalesOrders,
    }),
    collectedWeekLabel: t('home.vitals.collectedWeek'),
    collectedWeekValue: moneyCompact(data.badges.collected7d),
    collectedWeekSub: t('home.vitals.collectedWeekSub', { count: data.badges.receipts7d }),
    heroTitle: t('home.hero.title'),
    heroHint: t('home.hero.hint'),
    heroEmpty: t('home.hero.empty'),
    topExposure: data.topExposure,
    pulseTitle: t('home.pulse.title'),
    pulseLabels: {
      open: t('home.pulse.open'),
      overdue: t('home.pulse.overdue'),
      dso: t('home.pulse.dso'),
      cta: t('home.pulse.cta'),
    },
    arOutstanding: moneyCompact(data.arOutstanding),
    arOverdue: moneyCompact(data.arOverdue),
    arOverdueIsNegative: cmp(data.arOverdue, '0') > 0,
    dsoText: t('home.vitals.days', { n: data.dso }),
    arHref: `/ar${subQs}`,
    trendTitle: t('home.trend.title'),
    trendHint: t('home.trend.hint'),
    trendLabels: data.trend.map((w) => weekLabel(w.weekStart, locale)),
    // Chart coordinates are a bounded visual projection only. All monetary
    // aggregation, ranking, and text formatting above retain exact decimals.
    trendSeries: [{ name: t('home.trend.series'), data: data.trend.map((w) => chartMoneyCoordinate(w.collected)), color: '#10b981' }],
    directoryTitle: t('home.directory.title'),
    directory,
    attentionTitle: t('home.attention.title'),
    attentionAllClear: t('home.attention.allClear'),
    attention,
  }
}

type T = Awaited<ReturnType<typeof getTranslations<'customers'>>>

function chartMoneyCoordinate(amount: string): number {
  const limit = Number.MAX_SAFE_INTEGER
  const value = Number(amount)
  return Number.isFinite(value) ? Math.max(-limit, Math.min(limit, value)) : value < 0 ? -limit : limit
}

export function needsAttention(
  exposure: CustomerExposureRow[],
  t: T,
  moneyCompact: (value: string) => string,
): CustomerAttentionItem[] {
  const items: CustomerAttentionItem[] = []
  for (const r of exposure) {
    if (cmp(r.overdue, '0') > 0) {
      items.push({
        tone: cmp(mulDecimal(r.overdue, '2'), r.open) > 0 ? 'negative' : 'warning',
        text: t('home.attention.overdueCustomer', { customer: r.name, amount: moneyCompact(r.overdue) }),
        href: '/ar',
      })
    }
  }
  return items.slice(0, 6)
}

export function weekLabel(weekStart: string, locale: string): string {
  return new Date(weekStart + 'T00:00:00Z').toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

const f = ref<CustomersData>()

export function customersSpec(data: CustomersData): PageSpec {
  return page({
    route: '/customers',
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
        // Vitals strip. The pipeline pair is CRM-gated and the quotes/orders
        // tile is orders-gated; `when` expresses that without the spec
        // gaining a conditional.
        grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5', [
          // I4-webui-225b: the count reads behind parties.read.
          statTile({ iconKey: 'users', accent: 'teal', label: f('activeCustomersLabel'), value: f('activeCustomersValue'), when: f('partiesAllowed') }),
          statTile({
            iconKey: 'trending-up',
            accent: 'violet',
            label: f('pipelineLabel'),
            value: f('pipelineValue'),
            sub: f('pipelineSub'),
            when: f('crmEnabled'),
          }),
          statTile({
            iconKey: 'check-circle',
            accent: 'emerald',
            label: f('closedQuarterLabel'),
            value: f('closedQuarterValue'),
            tone: 'positive',
            when: f('crmEnabled'),
          }),
          statTile({
            iconKey: 'clipboard',
            accent: 'sky',
            label: f('quotesOrdersLabel'),
            value: f('quotesOrdersValue'),
            sub: f('quotesOrdersSub'),
            when: f('ordersEnabled'),
          }),
          statTile({
            iconKey: 'wallet',
            accent: 'emerald',
            label: f('collectedWeekLabel'),
            value: f('collectedWeekValue'),
            sub: f('collectedWeekSub'),
            tone: 'positive',
            // I4-webui-225b: collections read behind ar.read.
            when: f('arAllowed'),
          }),
        ]),

        grid('grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3', [
          panel({
            title: f('heroTitle'),
            iconKey: 'users',
            hint: f('heroHint'),
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            className: 'min-h-[24rem] lg:col-span-2',
            // I4-webui-225b: the roster is AR balances; hide it unread.
            when: f('arAllowed'),
            blocks: [
              // The empty state lives inside the section component, not as a
              // negated conditional pair of blocks — see ./sections.
              widgetBlock('relationships-section', {
                rows: data.topExposure,
                crmEnabled: data.crmEnabled,
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
              // I4-webui-225b: AR pulse reads behind ar.read.
              when: f('arAllowed'),
              blocks: [
                widgetBlock('customer-ar-pulse', {
                  outstanding: data.arOutstanding,
                  overdue: data.arOverdue,
                  overdueIsNegative: data.arOverdueIsNegative,
                  dso: data.dsoText,
                  labels: data.pulseLabels,
                  href: data.arHref,
                }),
              ],
            }),
            panel({
              title: f('trendTitle'),
              iconKey: 'area-chart',
              hint: f('trendHint'),
              className: 'shrink-0',
              // I4-webui-225b: the collections trend reads behind ar.read.
              when: f('arAllowed'),
              blocks: [
                widgetBlock('trend-chart', {
                  labels: data.trendLabels,
                  series: data.trendSeries,
                  height: 170,
                  area: true,
                }),
              ],
            }),
            // The empty case is owned by the widget (it returns null with no
            // items), matching the native `directory.length > 0` guard.
            widgetBlock('directory-section', { items: data.directory, title: data.directoryTitle }, f('partiesAllowed')),
            panel({
              title: f('attentionTitle'),
              iconKey: 'triangle-alert',
              bodyClassName: 'p-0',
              className: 'shrink-0',
              // I4-webui-225b: attention derives from AR exposure — never
              // render its all-clear state to an AR-unreadable caller.
              when: f('arAllowed'),
              blocks: [
                // The all-clear state lives inside the shared AttentionList,
                // not as a conditional pair of blocks.
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
