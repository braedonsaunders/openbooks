'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  BadgePercent,
  Banknote,
  BarChart3,
  Boxes,
  Briefcase,
  Building,
  Building2,
  CalendarCheck,
  ChartLine,
  CircleDollarSign,
  Code2,
  Coins,
  CreditCard,
  Database,
  Factory,
  FileSignature,
  Gauge,
  Gift,
  Globe,
  Handshake,
  Hash,
  HeartHandshake,
  History,
  IdCard,
  KeyRound,
  Landmark,
  Layers,
  LayoutGrid,
  Lock,
  Megaphone,
  Network,
  Package,
  PackageCheck,
  PlugZap,
  Puzzle,
  Radio,
  Receipt,
  RefreshCcw,
  Repeat2,
  ScanBarcode,
  ScrollText,
  Shapes,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Split,
  Store,
  Target,
  TrendingUp,
  Truck,
  Undo2,
  Users,
  Wallet,
  Warehouse,
  Webhook,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { Button, PageHeader, cn } from '@openbooks/ui'
import { FEATURE_CATEGORIES, type FeatureCategory } from '@openbooks/engine/organization/feature-catalog'
import { ModuleHomeTabs } from '@/components/module-home/tabs'
import { SearchInput } from '@/components/search-input'
import { Switch } from '@/components/switch'
import { confirmDialog } from '../../../../../lib/confirm'
import {
  OTHER_INDUSTRY_MODULES,
  buildFeatureTree,
  featureSearchMatcher,
  featureToggleRefusalMessage,
  filterFeatureTree,
  industryLenses,
  type FeatureIndustry,
  type FeatureTreeNode,
  type FeatureTreeSection,
} from './feature-tree'

type Feature = {
  key: string
  category: string
  enabled: boolean
  parentKey?: string
  requiresAll?: string[]
  recommends?: string[]
}
type Impact = { labelKey: string; count: number }
type DisableStatus = { blocked: boolean; impacts: Impact[] }

/** Icon per top-level feature row (nested rows render without one) — falls
 *  back to a neutral puzzle piece when unmapped. */
const ICONS: Record<string, LucideIcon> = {
  // Finance
  multiSubsidiary: Building2,
  multiCurrency: Coins,
  banking: Landmark,
  bankFeeds: Radio,
  fixedAssets: Boxes,
  budgets: Target,
  allocations: Split,
  crossBorderTax: Globe,
  continuousClose: CalendarCheck,
  advancedClose: ShieldCheck,
  // Sales
  crm: Users,
  orders: ShoppingCart,
  customerPartNumbers: Hash,
  promotions: BadgePercent,
  cashSales: Banknote,
  storedValue: Gift,
  salesChannels: Store,
  // Billing
  subscriptionBilling: Repeat2,
  advancedSubscriptions: Layers,
  usageBilling: Gauge,
  quoteToCash: FileSignature,
  consolidatedBilling: Network,
  saasMetrics: ChartLine,
  billingHistoryImport: History,
  onlinePayments: CreditCard,
  autopay: RefreshCcw,
  revenueRecognition: TrendingUp,
  contractCosts: CircleDollarSign,
  // Inventory
  inventory: Package,
  itemVariants: Shapes,
  barcodeScanning: ScanBarcode,
  warehousing: Warehouse,
  fulfillment: PackageCheck,
  returnAuthorizations: Undo2,
  dropShipping: Truck,
  demandPlanning: BarChart3,
  manufacturing: Factory,
  // Projects
  projects: Briefcase,
  preBilling: CircleDollarSign,
  subcontracts: Handshake,
  subcontractorCompliance: ShieldCheck,
  equipment: Wrench,
  // People
  hrm: IdCard,
  payroll: Wallet,
  expenses: Receipt,
  // Industries
  propertyManagement: Building,
  nonprofit: HeartHandshake,
  // Platform
  flows: Workflow,
  homeAnnouncements: Megaphone,
  aiGovernanceLedger: ScrollText,
  apps: LayoutGrid,
  scripts: Code2,
  apiAccess: KeyRound,
  outboundWebhooks: Webhook,
  mcpAccess: PlugZap,
  queryConsole: Database,
}

/** The `?tab=` value when it names a category; the first tab otherwise. */
function activeCategory(value: string | null): FeatureCategory {
  return FEATURE_CATEGORIES.find((category) => category === value) ?? FEATURE_CATEGORIES[0]
}

/**
 * The Features switchboard — one tab per registry category (`?tab=`), each a
 * settings list (icon · name · description · switch) in registry order.
 * Saves on toggle; nav re-renders so gated modules appear/disappear. Turning
 * a feature off surfaces what it affects: integrity-critical features (e.g.
 * multi-subsidiary once posted-to) lock; the rest confirm, listing the
 * records that will be hidden.
 *
 * Search filters in place across EVERY tab — an operator looking for a
 * capability should not have to know which tab owns it — and renders the
 * matches grouped under their tab names, with per-tab match counts on the
 * tab strip. Choosing a tab clears the search.
 *
 * The Industries tab is a per-vertical view: one section per supported
 * industry (the org's own first), listing the switches that industry's
 * wizard preset turns on — the same switches the home tabs carry, never a
 * second gate. Industry-only modules no preset names still render, under
 * "Other industry modules", so no switch can fall off the page.
 *
 * Hierarchy: features that declare a `parentKey` render NESTED under their
 * parent row — indented, smaller, behind a quiet rail — and are not rendered
 * at all while the parent is off. The parent row then carries a
 * "N options once enabled" hint instead. Hiding is presentation only: stored
 * values are untouched, so re-enabling the parent restores its children.
 * `requiresAll` entries are cross-module requirements, not children, and stay
 * top-level rows with their "Requires X" reason. Counts cover only visible
 * rows so the numbers stay honest.
 */
export function FeaturesWorkspace({
  features,
  disableStatus = {},
  wizardHref,
  industries = [],
  orgIndustry = null,
}: {
  features: Feature[]
  disableStatus?: Record<string, DisableStatus>
  wizardHref?: string
  industries?: FeatureIndustry[]
  orgIndustry?: string | null
}) {
  const t = useTranslations('admin')
  const router = useRouter()
  const pathname = usePathname()
  const tab = activeCategory(useSearchParams().get('tab'))
  const [state, setState] = useState<Record<string, boolean>>(
    () => Object.fromEntries(features.map((f) => [f.key, f.enabled])),
  )
  const [pending, setPending] = useState<string | null>(null)
  const [awaitingRefresh, setAwaitingRefresh] = useState(false)
  const [query, setQuery] = useState('')

  // A tab change (including back/forward) is a deliberate change of scope:
  // drop a cross-tab search so the chosen tab is what renders. Adjusted
  // during render, never in an effect.
  const [queryTab, setQueryTab] = useState(tab)
  if (queryTab !== tab) {
    setQueryTab(tab)
    setQuery('')
  }

  // Re-sync from the server after router.refresh(): a toggle commits on the
  // server, and derived rows (children of a freshly enabled parent, or rows
  // whose requirements just resolved) read differently there than in this
  // island's initial snapshot. Adjusted during render (never in an effect),
  // and never while an optimistic toggle is in flight.
  const [syncedFeatures, setSyncedFeatures] = useState(features)
  if (syncedFeatures !== features && pending === null) {
    setSyncedFeatures(features)
    setState(Object.fromEntries(features.map((f) => [f.key, f.enabled])))
    setAwaitingRefresh(false)
  }

  /** Comma-joined "12 reconciliations, 340 bank statements" from a feature's impacts. */
  const impactText = (impacts: Impact[]) =>
    impacts.map((i) => t(`setup.features.impacts.${i.labelKey}`, { count: i.count })).join(', ')

  async function toggle(key: string) {
    if (pending || awaitingRefresh) return
    const status = disableStatus[key]
    const next = !state[key]

    if (!next) {
      if (state[key] && status?.blocked) return // locked — shouldn't reach here
      // Confirm before hiding real records.
      if (status && status.impacts.length > 0) {
        const ok = await confirmDialog({
          message: t('setup.features.confirmDisable', {
            name: t(`features.${key}.title`),
            items: impactText(status.impacts),
          }),
          tone: 'danger',
        })
        if (!ok) return
      }
    }

    setState((s) => ({ ...s, [key]: next }))
    setPending(key)
    try {
      const res = await fetch('/api/admin/setup/features', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features: { [key]: next } }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        throw new Error(featureToggleRefusalMessage(payload, (key, params) => t(key, params)))
      }
      toast.success(t(next ? 'setup.features.enabled' : 'setup.features.disabled', { name: t(`features.${key}.title`) }))
      setAwaitingRefresh(true)
      router.refresh()
    } catch (e) {
      setState((s) => ({ ...s, [key]: !next }))
      setAwaitingRefresh(false)
      toast.error((e as Error).message)
    } finally {
      setPending(null)
    }
  }

  // Nested sections: children attach to their parent's group (in registry
  // order) and vanish — from the page AND the counts — while the parent is off.
  const sections = buildFeatureTree(features, state, FEATURE_CATEGORIES)
  const categoryLabel = (category: string) => t(`setup.features.categories.${category}`)
  // Search reads what the operator reads: the row's title, description and
  // tab name, plus its parent's title so "projects" finds every project
  // capability.
  const matcher = featureSearchMatcher(query, (row) => [
    t(`features.${row.key}.title`),
    t(`features.${row.key}.description`),
    categoryLabel(row.category),
    ...(row.parentKey ? [t(`features.${row.parentKey}.title`)] : []),
  ])
  const results = matcher ? filterFeatureTree(sections, matcher) : null
  const home = sections.find((section) => section.category === tab)
  const lenses = tab === 'industries' ? industryLenses(sections, industries, orgIndustry) : []
  // The Industries tab repeats switches across verticals; its summary counts
  // each feature once.
  const lensNodes = new Map(
    lenses.flatMap(({ section }) =>
      section.groups.flatMap((group) => [group.parent, ...group.visibleChildren].map((node) => [node.row.key, node] as const)),
    ),
  )
  const current: FeatureTreeSection | undefined =
    tab === 'industries'
      ? {
          category: tab,
          groups: [],
          visibleTotal: lensNodes.size,
          visibleOn: [...lensNodes.values()].filter((node) => node.on).length,
        }
      : home
  const resultCount = (category: string) =>
    results?.find((section) => section.category === category)?.visibleTotal ?? 0
  const countOn = (section: FeatureTreeSection | undefined) =>
    t('setup.features.countOn', { n: section?.visibleOn ?? 0, total: section?.visibleTotal ?? 0 })

  /** One switchboard row: parent rows full-size, nested children compact. */
  const renderRow = (node: FeatureTreeNode, compact: boolean, hintCount = 0) => {
    const f = node.row
    const status = disableStatus[f.key]
    const missingRequirements = node.missingRequirements
    const dependencyLocked = missingRequirements.length > 0
    const isOn = node.on
    const missingRecommendations = (f.recommends ?? []).filter((key) => !state[key])
    const blocked = isOn && Boolean(status?.blocked)
    const impacts = status?.impacts ?? []
    return (
      <FeatureRow
        key={f.key}
        icon={ICONS[f.key] ?? Puzzle}
        title={t(`features.${f.key}.title`)}
        description={t(`features.${f.key}.description`)}
        on={isOn}
        blocked={blocked}
        compact={compact}
        reason={
          dependencyLocked
            ? t('setup.features.requiresNote', { names: missingRequirements.map((key) => t(`features.${key}.title`)).join(', ') })
            : hintCount > 0
              ? t('setup.features.childOptions', { count: hintCount })
              : blocked
                ? t('setup.features.blockedReason', { items: impactText(impacts) })
                : isOn && impacts.length > 0
                  ? t('setup.features.affectsNote', { items: impactText(impacts) })
                  : isOn && missingRecommendations.length > 0
                    ? t('setup.features.recommendsNote', { names: missingRecommendations.map((key) => t(`features.${key}.title`)).join(', ') })
                    : undefined
        }
        reasonTone={blocked || dependencyLocked ? 'block' : 'info'}
        busy={pending === f.key}
        disabled={dependencyLocked || pending !== null || awaitingRefresh}
        onToggle={() => toggle(f.key)}
        depth={node.depth}
      />
    )
  }

  /** One bordered panel: each parent row, then its visible children on a rail. */
  const renderPanel = (section: FeatureTreeSection) => (
    <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
      {section.groups.map((group) => (
        <div key={group.parent.row.key}>
          {renderRow(group.parent, false, group.hiddenChildCount)}
          {group.visibleChildren.length > 0 && (
            <div className="border-t border-slate-100 dark:border-slate-800">
              <div className="ml-12 border-l border-slate-200 pl-1 dark:border-slate-700">
                {group.visibleChildren.map((child, index) => (
                  <div
                    key={child.row.key}
                    className={cn(index > 0 && 'border-t border-slate-100 dark:border-slate-800')}
                  >
                    {renderRow(child, true)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('setup.features.title')}
        description={t('setup.features.description')}
        actions={
          // Choosing a tab ends a search even when the URL does not change
          // (the tab already in `?tab=`), so the chosen tab always renders.
          <div className="contents" onClickCapture={(event) => {
            if ((event.target as Element).closest('a')) setQuery('')
          }}>
            <ModuleHomeTabs
              ariaLabel={t('setup.features.tabsAria')}
              tabs={sections.map((section) => ({
                href: `${pathname}?tab=${section.category}`,
                label: categoryLabel(section.category),
                // While searching, the body spans every tab, so no tab claims
                // it; each instead counts the matches it holds.
                active: !results && section.category === tab,
                count: results ? resultCount(section.category) : undefined,
              }))}
            />
          </div>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput placeholder={t('setup.features.searchPlaceholder')} value={query} onValueChange={setQuery} />
        <div className="flex items-center gap-3">
          {results ? null : (
            <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{countOn(current)}</span>
          )}
          {wizardHref ? (
            <Button asChild variant="outline" size="sm">
              <Link href={wizardHref}>
                <Sparkles size={15} aria-hidden /> {t('setup.features.runWizard')}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      {results ? (
        results.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
            {t('setup.features.noMatches', { query: query.trim() })}
          </p>
        ) : (
          results.map((section) => (
            <section key={section.category} className="space-y-2.5">
              <div className="flex items-baseline justify-between px-1">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {categoryLabel(section.category)}
                </h3>
                <span className="text-xs tabular-nums text-slate-400 dark:text-slate-500">{countOn(section)}</span>
              </div>
              {renderPanel(section)}
            </section>
          ))
        )
      ) : tab === 'industries' ? (
        lenses.map(({ key, section }) => (
          <section key={key} className="space-y-2.5">
            <div className="flex items-end justify-between gap-4 px-1">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {key === OTHER_INDUSTRY_MODULES
                    ? t('setup.features.otherIndustryModules')
                    : t(`setup.wizard.industries.${key}.title`)}
                  {key === orgIndustry ? (
                    <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
                      {t('setup.features.yourIndustry')}
                    </span>
                  ) : null}
                </h3>
                {key === OTHER_INDUSTRY_MODULES ? null : (
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {t(`setup.wizard.industries.${key}.description`)}
                  </p>
                )}
              </div>
              <span className="shrink-0 text-xs tabular-nums text-slate-400 dark:text-slate-500">{countOn(section)}</span>
            </div>
            {renderPanel(section)}
          </section>
        ))
      ) : home ? (
        renderPanel(home)
      ) : null}
    </div>
  )
}

function FeatureRow({
  icon: Icon,
  title,
  description,
  on,
  blocked,
  reason,
  reasonTone,
  busy,
  disabled,
  onToggle,
  compact = false,
  depth = 0,
}: {
  icon: LucideIcon
  title: string
  description: string
  on: boolean
  blocked: boolean
  reason?: string
  reasonTone: 'block' | 'info'
  busy: boolean
  disabled: boolean
  onToggle: () => void
  /** Nested child row: no icon square, tighter padding, secondary type. */
  compact?: boolean
  depth?: number
}) {
  return (
    <div
      className={cn('flex items-start', compact ? 'gap-3 py-3 pr-4' : 'gap-4 p-4')}
      style={compact ? { paddingLeft: `${16 + Math.max(0, depth - 1) * 24}px` } : undefined}
    >
      {compact ? null : (
        <div
          className={cn(
            'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors',
            on
              ? 'bg-teal-50 text-teal-600 dark:bg-teal-950/50 dark:text-teal-300'
              : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
          )}
        >
          <Icon size={18} aria-hidden />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'font-medium',
              compact
                ? 'text-[13px] text-slate-800 dark:text-slate-200'
                : 'text-sm text-slate-900 dark:text-slate-100',
            )}
          >
            {title}
          </span>
          {blocked ? (
            <Lock size={12} className="shrink-0 text-slate-400 dark:text-slate-500" aria-hidden />
          ) : null}
        </div>
        <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>
        {reason ? (
          <p
            className={cn(
              'mt-1.5 text-xs font-medium',
              reasonTone === 'block'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-slate-400 dark:text-slate-500',
            )}
          >
            {reason}
          </p>
        ) : null}
      </div>

      <Switch on={on} disabled={blocked || busy || disabled} onToggle={onToggle} label={title} className="mt-0.5" />
    </div>
  )
}
