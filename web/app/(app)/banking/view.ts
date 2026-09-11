import 'server-only'

import { getMoneyFormatter } from '@/lib/money-server'
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
import { requirePermission, can } from '../../../lib/authz'
import { resolveNav } from '../../../lib/nav/resolve'
import { reportSubsidiaryView } from '../../../lib/consolidation'
import { resolveAsOf } from '../../../lib/cash/core'
import { bankingHome, type BankingAccountRow } from '../../../lib/module-home/banking'
import { userPageLayout } from '../../../lib/page-layout'
import { groupTabs } from '../../../components/module-home/group-tabs'
import type { DirectoryItem } from '../../../components/module-home/ui'
import type { BankingAttentionItem } from './sections'

/**
 * The banking cockpit, split into a loader and a spec.
 *
 * This follows the purchasing-cockpit archetype, not a list page: ViewSpec
 * composes the grid and the panels; the panel BODIES stay components, shared
 * by the page and the widget registry via ./sections so they cannot drift (see
 * ../../purchasing/view.ts for the division and its rationale).
 *
 * Three components the purchasing page rendered directly become widgets/slots
 * here:
 *
 * - The vitals strip is five `stat-tile` blocks: the tile renders the same
 *   HomeStatTile the native page renders, so no widget is needed. Every tone
 *   and accent decision is a loader-resolved string.
 * - The trend chart and live directory already exist in the registry
 *   (`trend-chart`, `live-directory`); the directory heading is native `<h3>`
 *   markup, exactly the shape the purchasing `directory-section` widget
 *   already wraps — but that widget's empty case returns null with NO outer
 *   wrapper while the native banking page renders `<div className="shrink-0">`
 *   only when the directory is non-empty, so the shared `directory-section`
 *   component matches by construction and is reused rather than copied.
 * - The account roster is the page's headline object AND a live workspace:
 *   per-user hide/reorder prefs (persisted through /api/me/page-layout)
 *   with per-row client state. The loader performs the roster's server work
 *   (the prefs fetch — a user capability the LOADER may hold) and passes the
 *   prefs through as data; persistence rides the session cookie inside the
 *   shared component, so no user id, org id or Authz crosses the spec. The
 *   `banking-roster` widget renders the shared
 *   AccountsRosterPanel over that data — a widget, not a slot, because there
 *   is no capability left to re-derive.
 * - The header's Match button is a conditional PAIR (count label when
 *   unmatched, plain label when clean) with a variant flip — a component,
 *   not a spec construct. It renders through the `banking-match`
 *   widget over loader-resolved strings.
 */

/** Statements older than this are flagged as a stale feed on the roster. */
const STALE_STATEMENT_DAYS = 30

type SubsidiaryPicker = Awaited<ReturnType<typeof reportSubsidiaryView>>['picker']
type Tabs = Awaited<ReturnType<typeof groupTabs>>

export interface BankingData {
  title: string
  description: string
  layoutPrefs: Record<string, unknown>
  subsidiaryPicker: SubsidiaryPicker
  subsidiaryValue: string
  subsidiaryLabel: string
  tabs: Tabs
  canReconcile: boolean
  matchHref: string
  matchVariant: 'default' | 'outline'
  matchCountLabel: string
  matchLabel: string
  showMatchCount: boolean
  cashLabel: string
  cashValue: string
  cashSub: string
  cashTone: 'negative' | 'neutral'
  unmatchedTone: 'warning' | 'positive'
  cardsLabel: string
  cardsValue: string
  cardsSub: string
  unmatchedLabel: string
  unmatchedValue: string
  unmatchedSub: string
  unmatchedAccent: 'amber' | 'emerald'
  openReconsLabel: string
  openReconsValue: string
  openReconsSub: string
  netFlowLabel: string
  netFlowValue: string
  netFlowAccent: 'emerald' | 'red'
  netFlowTone: 'positive' | 'negative'
  rosterTitle: string
  rosterAccounts: BankingAccountRow[]
  totalCash: number
  totalCards: number
  trendTitle: string
  trendHint: string
  trendSeriesName: string
  trendLabels: string[]
  trendData: number[]
  directoryTitle: string
  directory: DirectoryItem[]
  attentionTitle: string
  attentionAllClear: string
  attention: BankingAttentionItem[]
}

export async function loadBanking(
  sp: Record<string, string | string[] | undefined>,
): Promise<BankingData> {
  const { moneyCompact } = await getMoneyFormatter()
  const authz = await requirePermission('banking.read')
  const canReconcile = can(authz, 'banking.reconcile')
  const t = await getTranslations('banking')
  const tNav = await getTranslations('nav')

  // Subsidiary context — multi-subsidiary orgs get a switcher; the whole page
  // (roster, balances, trend, badges) scopes to the selected view.
  const subView = await reportSubsidiaryView(sp.sub as string | undefined, await resolveAsOf(authz.user.orgId))

  const [data, rosterPrefs, navGroups] = await Promise.all([
    bankingHome(authz.user.orgId, subView.subsidiary?.ids),
    userPageLayout(authz.user.id, 'banking-accounts'),
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

  // The home reflects the org's OWN menu: tabs and directory come from the
  // resolved banking group, so hidden items vanish and custom labels hold.
  const groupItems = navGroups.find((g) => g.id === 'banking')?.items ?? []
  const subQs = sp.sub ? `?sub=${sp.sub}` : ''
  const tabs = await groupTabs('banking', '/banking', { subQs, orgId: authz.user.orgId })

  const lastImportAge = daysSince(data.badges.lastImportedAt)
  const badgeFor = (href: string): DirectoryItem['badge'] => {
    switch (href) {
      case '/banking/match':
        return data.unmatchedLines > 0
          ? { value: String(data.unmatchedLines), hint: t('home.directory.matchHint'), tone: 'warning' }
          : { value: '0', hint: t('home.directory.matchClear'), tone: 'positive' }
      case '/banking/reconciliations':
        return {
          value: String(data.openRecons),
          hint: t('home.directory.reconsHint'),
          tone: data.openRecons > 0 ? 'neutral' : 'positive',
        }
      case '/banking/rules':
        return {
          value: String(data.badges.activeRules),
          hint: t('home.directory.rulesHint', { total: data.badges.totalRules }),
        }
      case '/banking/imports':
        return {
          value: String(data.badges.statements),
          hint:
            data.badges.lastImportedAt === null
              ? t('home.directory.importsNever')
              : t('home.directory.importsHint', { days: lastImportAge ?? 0 }),
          tone: lastImportAge !== null && lastImportAge > STALE_STATEMENT_DAYS ? 'warning' : 'neutral',
        }
      case '/banking/transactions':
        return { value: String(data.badges.txns7d), hint: t('home.directory.transactionsHint') }
      default:
        return undefined
    }
  }
  const directory: DirectoryItem[] = groupItems
    .filter((i) => i.href !== '/banking' && i.href !== '/banking/cash')
    .map((i) => ({ href: i.href, label: i.label, iconKey: i.iconKey, badge: badgeFor(i.href) }))

  const banks = data.accounts.filter((a) => a.type === 'asset_bank')
  const cards = data.accounts.filter((a) => a.type !== 'asset_bank')

  return {
    title: t('home.title'),
    description: t('home.description'),
    layoutPrefs: rosterPrefs as unknown as Record<string, unknown>,
    subsidiaryPicker: subView.picker,
    subsidiaryValue: subView.picker.find((p) => p.id === sp.sub)?.id ?? subView.picker[0]?.id ?? '',
    subsidiaryLabel: t('home.subsidiary'),
    tabs,
    canReconcile,
    matchHref: '/banking/match',
    matchVariant: data.unmatchedLines > 0 ? 'default' : 'outline',
    matchCountLabel: t('home.actions.matchCount', { count: data.unmatchedLines }),
    matchLabel: t('home.actions.match'),
    showMatchCount: data.unmatchedLines > 0,
    cashLabel: t('home.vitals.cash'),
    cashValue: moneyCompact(data.totalCash),
    cashSub: t('home.vitals.accountCount', { count: banks.length }),
    cashTone: data.totalCash < 0 ? 'negative' : 'neutral',
    unmatchedTone: data.unmatchedLines > 0 ? 'warning' : 'positive',
    cardsLabel: t('home.vitals.cards'),
    cardsValue: moneyCompact(data.totalCards),
    cardsSub: t('home.vitals.accountCount', { count: cards.length }),
    unmatchedLabel: t('home.vitals.unmatched'),
    unmatchedValue: data.unmatchedLines.toLocaleString(),
    unmatchedSub: data.unmatchedLines > 0 ? t('home.vitals.unmatchedSub') : t('home.vitals.allMatched'),
    unmatchedAccent: data.unmatchedLines > 0 ? 'amber' : 'emerald',
    openReconsLabel: t('home.vitals.openRecons'),
    openReconsValue: data.openRecons.toLocaleString(),
    openReconsSub: data.openRecons > 0 ? t('home.vitals.openReconsSub') : t('home.vitals.noneOpen'),
    netFlowLabel: t('home.vitals.netFlow'),
    netFlowValue: moneyCompact(data.netFlow7d),
    netFlowAccent: data.netFlow7d >= 0 ? 'emerald' : 'red',
    netFlowTone: data.netFlow7d >= 0 ? 'positive' : 'negative',
    rosterTitle: t('home.roster.title'),
    rosterAccounts: data.accounts,
    totalCash: data.totalCash,
    totalCards: data.totalCards,
    trendTitle: t('home.trend.title'),
    trendHint: t('home.trend.hint'),
    trendSeriesName: t('home.trend.series'),
    trendLabels: data.trend.map((w) => weekLabel(w.weekStart)),
    trendData: data.trend.map((w) => w.balance),
    directoryTitle: t('home.directory.title'),
    directory,
    attentionTitle: t('home.attention.title'),
    attentionAllClear: t('home.attention.allClear'),
    attention: needsAttention(data.accounts, t),
  }
}

type T = Awaited<ReturnType<typeof getTranslations<'banking'>>>

export function needsAttention(accounts: BankingAccountRow[], t: T): BankingAttentionItem[] {
  const items: BankingAttentionItem[] = []
  for (const a of accounts) {
    if (a.type === 'asset_bank' && a.balance < 0) {
      items.push({ tone: 'negative', text: t('home.attention.negativeBalance', { account: a.name }), href: `/banking/${a.id}` })
    }
  }
  for (const a of accounts) {
    const age = daysSince(a.lastStatementDate)
    if (a.lastStatementDate === null) {
      items.push({ tone: 'warning', text: t('home.attention.noStatement', { account: a.name }), href: `/banking/${a.id}` })
    } else if (age !== null && age > STALE_STATEMENT_DAYS) {
      items.push({
        tone: 'warning',
        text: t('home.attention.staleStatement', { account: a.name, days: age }),
        href: `/banking/${a.id}`,
      })
    }
  }
  for (const a of accounts) {
    if (a.openReconciliationId) {
      items.push({
        tone: 'neutral',
        text: t('home.attention.openRecon', { account: a.name }),
        href: `/banking/${a.id}/reconcile/${a.openReconciliationId}`,
      })
    }
  }
  return items.slice(0, 6)
}

export function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000))
}

export function weekLabel(weekStart: string): string {
  return new Date(weekStart + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

const f = ref<BankingData>()

export function bankingSpec(data: BankingData): PageSpec {
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
          // Conditional PAIR (count label when unmatched, plain label when
          // clean) with a variant flip — a component, not a spec construct.
          // The `banking-match` widget renders the
          // shared Button+Link chrome over these loader-resolved strings.
          widget(
            'banking-match',
            {
              href: data.matchHref,
              variant: data.matchVariant,
              countLabel: data.matchCountLabel,
              label: data.matchLabel,
              showCount: data.showMatchCount,
            },
            f('canReconcile'),
          ),
        ],
      }),
    ],
    body: [
      grid('flex h-full min-h-0 flex-col gap-4', [
        // Vitals strip. Every tile renders the same HomeStatTile the native
        // page renders; every tone and accent is a loader-resolved string.
        // `tone` narrows the block union to the four tones StatTile supports;
        // the cash tile's 'default' is StatTile's own default.
        grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5', [
          statTile({
            iconKey: 'landmark',
            accent: 'indigo',
            label: f('cashLabel'),
            value: f('cashValue'),
            sub: f('cashSub'),
            tone: f('cashTone'),
          }),
          statTile({
            iconKey: 'credit-card',
            accent: 'violet',
            label: f('cardsLabel'),
            value: f('cardsValue'),
            sub: f('cardsSub'),
          }),
          // The native tile DOES carry a tone: warning while lines are
          // unmatched, positive once they are clear. The accent flips with it.
          statTile({
            iconKey: 'list-checks',
            accent: f('unmatchedAccent'),
            label: f('unmatchedLabel'),
            value: f('unmatchedValue'),
            sub: f('unmatchedSub'),
            tone: f('unmatchedTone'),
          }),
          statTile({
            iconKey: 'check-circle',
            accent: 'teal',
            label: f('openReconsLabel'),
            value: f('openReconsValue'),
            sub: f('openReconsSub'),
          }),
          statTile({
            iconKey: 'arrow-left-right',
            accent: f('netFlowAccent'),
            label: f('netFlowLabel'),
            value: f('netFlowValue'),
            tone: f('netFlowTone'),
          }),
        ]),

        grid('grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3', [
          // Roster hero. The loader performs the roster's server work (the
          // user_page_layouts prefs fetch) and passes the prefs through as
          // data; the `banking-roster` widget
          // renders the shared AccountsRosterPanel over them. A widget, not
          // a slot: persistence rides the session cookie, so no capability
          // crosses the spec.
          widgetBlock('banking-roster', {
            accounts: data.rosterAccounts,
            totalCash: data.totalCash,
            totalCards: data.totalCards,
            layoutPrefs: data.layoutPrefs,
          }),

          grid('flex min-h-0 flex-col gap-5 overflow-y-auto', [
            panel({
              title: f('trendTitle'),
              iconKey: 'area-chart',
              hint: f('trendHint'),
              className: 'shrink-0',
              blocks: [
                widgetBlock('trend-chart', {
                  labels: data.trendLabels,
                  series: [{ name: data.trendSeriesName, data: data.trendData }],
                  height: 170,
                  area: true,
                }),
              ],
            }),
            // The native page wraps the directory heading + LiveDirectory in
            // `<div className="shrink-0">` ONLY when non-empty. The shared
            // `directory-section` component (purchasing/sections.tsx) renders
            // exactly that wrapper-or-null pair, so it is reused, not copied —
            // no `when` needed, the empty case lives inside the component.
            widgetBlock('directory-section', {
              items: data.directory,
              title: data.directoryTitle,
            }),
            panel({
              title: f('attentionTitle'),
              iconKey: 'triangle-alert',
              bodyClassName: 'p-0',
              className: 'shrink-0',
              blocks: [
                // The empty case lives inside the shared component, not as a
                // negated conditional pair of blocks — see ./sections.
                widgetBlock('banking-attention-list', {
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
