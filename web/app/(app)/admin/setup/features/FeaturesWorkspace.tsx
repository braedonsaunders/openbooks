'use client'

import { useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Puzzle, Sparkles } from 'lucide-react'
import { Button, PageHeader } from '@openbooks/ui'
import { FEATURE_CATEGORIES, FEATURE_GROUPS, type FeatureCategory } from '@openbooks/engine/organization/feature-catalog'
import { ModuleHomeTabs } from '@/components/module-home/tabs'
import { SearchInput } from '@/components/search-input'
import { confirmDialog } from '../../../../../lib/confirm'
import {
  buildFeatureTree,
  summarizeFeatures,
  featureSearchMatcher,
  featureToggleRefusalMessage,
  filterFeatureTree,
  groupFeatureSections,
  type FeatureTreeNode,
  type FeatureTreeSection,
} from './feature-tree'
import { FEATURE_ICONS, FeatureRow, FeatureTreePanel, featureGroupLabel, featureRowReason } from './FeatureSwitchboard'

type Feature = {
  key: string
  category: string
  group?: string
  enabled: boolean
  parentKey?: string
  requiresAll?: string[]
  recommends?: string[]
}
type Impact = { labelKey: string; count: number }
type DisableStatus = { blocked: boolean; impacts: Impact[] }

function subscribeFeatureHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange)
  window.addEventListener('popstate', onChange)
  return () => { window.removeEventListener('hashchange', onChange); window.removeEventListener('popstate', onChange) }
}
const featureHash = () => window.location.hash

/** The `?tab=` value when it names a category; the first tab otherwise. */
function activeCategory(value: string | null): FeatureCategory {
  return FEATURE_CATEGORIES.find((category) => category === value) ?? FEATURE_CATEGORIES[0]
}

/**
 * The Features switchboard — one tab per registry category (`?tab=`), each a
 * grouped settings list (icon · name · description · switch). Presentation
 * groups come from the same registry and preserve every dependency and gate.
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
 * Hierarchy: features that declare a `parentKey` render NESTED under their
 * parent row — indented, smaller, behind a quiet rail — and are not rendered
 * at all while the parent is off. The parent row then carries a
 * "N options once enabled" hint instead. Hiding is presentation only: stored
 * values are untouched, so re-enabling the parent restores its children.
 * `requiresAll` entries are cross-module requirements, not children, and stay
 * top-level rows with their "Requires X" reason. The company summary counts
 * every registered capability, including children hidden behind an off parent.
 */
export function FeaturesWorkspace({
  features,
  disableStatus = {},
  wizardHref,
}: {
  features: Feature[]
  disableStatus?: Record<string, DisableStatus>
  wizardHref?: string
}) {
  const t = useTranslations('admin')
  const router = useRouter()
  const pathname = usePathname()
  const hash = useSyncExternalStore(subscribeFeatureHash, featureHash, () => '')
  const searchParams = useSearchParams()
  const tab = activeCategory(searchParams.get('tab'))
  const categoryHref = (category: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', category)
    return `${pathname}?${params}${hash}`
  }
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
  // order) and hide while the parent is off. The company summary retains them.
  const sections = buildFeatureTree(features, state, FEATURE_CATEGORIES)
  const categoryLabel = (category: string) => t(`setup.features.categories.${category}`)
  const groupLabel = (group: string) => featureGroupLabel(t, group)
  // Search reads what the operator reads: the row's title, description and
  // tab name, plus its parent's title so "projects" finds every project
  // capability.
  const matcher = featureSearchMatcher(query, (row) => [
    t(`features.${row.key}.title`),
    t(`features.${row.key}.description`),
    categoryLabel(row.category),
    ...(row.group ? [groupLabel(row.group)] : []),
    ...(row.parentKey ? [t(`features.${row.parentKey}.title`)] : []),
  ])
  const results = matcher ? filterFeatureTree(sections, matcher) : null
  const home = sections.find((section) => section.category === tab)
  const companySummary = summarizeFeatures(features, state)
  const resultCount = (category: string) =>
    results?.find((section) => section.category === category)?.visibleTotal ?? 0
  const countOn = (section: FeatureTreeSection | undefined) =>
    t('setup.features.countOn', { n: section?.visibleOn ?? 0, total: section?.visibleTotal ?? 0 })

  /** One switchboard row: parent rows full-size, nested children compact. */
  const renderRow = (node: FeatureTreeNode, compact: boolean, hintCount = 0) => {
    const f = node.row
    const status = disableStatus[f.key]
    const dependencyLocked = node.missingRequirements.length > 0
    const isOn = node.on
    const blocked = isOn && Boolean(status?.blocked)
    const impacts = status?.impacts ?? []
    const { reason, tone } = featureRowReason({
      node,
      hintCount,
      state,
      t: (key, params) => t(key, params),
      blocked,
      impacts: impacts.length > 0 ? impactText(impacts) : null,
    })
    return (
      <FeatureRow
        key={f.key}
        icon={FEATURE_ICONS[f.key] ?? Puzzle}
        title={t(`features.${f.key}.title`)}
        description={t(`features.${f.key}.description`)}
        on={isOn}
        blocked={blocked}
        compact={compact}
        reason={reason}
        reasonTone={tone}
        busy={pending === f.key}
        disabled={dependencyLocked || pending !== null || awaitingRefresh}
        onToggle={() => toggle(f.key)}
        depth={node.depth}
      />
    )
  }

  const renderPanel = (section: FeatureTreeSection) => (
    <FeatureTreePanel section={section} renderRow={renderRow} groupLabel={groupLabel} />
  )

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('setup.features.title')}
        description={t('setup.features.description')}
      />
      <div onClickCapture={(event) => {
        if ((event.target as Element).closest('a')) setQuery('')
      }}>
        <ModuleHomeTabs navigation="history" placement="local" ariaLabel={t('setup.features.tabsAria')}
          tabs={sections.map((section) => ({
            href: categoryHref(section.category),
            label: categoryLabel(section.category),
            active: !results && section.category === tab,
            count: results ? resultCount(section.category) : undefined,
          }))} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput placeholder={t('setup.features.searchPlaceholder')} value={query} onValueChange={setQuery} />
        <div className="flex items-center gap-3">
          <span data-feature-summary className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
            {t('setup.features.companyCountOn', companySummary)}
          </span>
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
      ) : home ? (
        groupFeatureSections(home, FEATURE_GROUPS[tab]).map(({ key, section }) => (
          <section key={key} className="space-y-2.5" aria-label={groupLabel(key)}>
            <h3 className="px-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{groupLabel(key)}</h3>
            {renderPanel(section)}
          </section>
        ))
      ) : null}
    </div>
  )
}
