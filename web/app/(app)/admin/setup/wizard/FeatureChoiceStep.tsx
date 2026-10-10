'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Puzzle } from 'lucide-react'
import { cn } from '@openbooks/ui'
import { FEATURE_CATEGORIES, FEATURE_GROUPS, type FeatureCategory } from '@openbooks/engine/organization/feature-catalog'
import { SearchInput } from '@/components/search-input'
import {
  buildFeatureTree,
  featureSearchMatcher,
  filterFeatureTree,
  groupFeatureSections,
  type FeatureTreeNode,
  type FeatureTreeRow,
  type FeatureTreeSection,
} from '../features/feature-tree'
import { FEATURE_ICONS, FeatureRow, FeatureTreePanel, featureGroupLabel, featureRowReason } from '../features/FeatureSwitchboard'

/**
 * The setup wizard's "pick my own features" step: the Company Settings →
 * Features switchboard over the same registry tree, nesting, requirement
 * locks and copy, with the choices held locally until the wizard applies
 * them. A child row is hidden while its parent is off and locked while any
 * requirement is off, so an operator can never compose a combination the
 * registry would refuse.
 */
export function FeatureChoiceStep({
  rows,
  state,
  onToggle,
}: {
  rows: FeatureTreeRow[]
  /** Raw switch choices; effective state is derived from the tree. */
  state: Readonly<Record<string, boolean>>
  onToggle: (key: string, next: boolean) => void
}) {
  const t = useTranslations('admin.setup.wizard')
  const tAdmin = useTranslations('admin')
  const [query, setQuery] = useState('')
  const sections = buildFeatureTree(rows, { ...state }, FEATURE_CATEGORIES)
  const [tab, setTab] = useState<string>(() => sections[0]?.category ?? '')
  const categoryLabel = (category: string) => tAdmin(`setup.features.categories.${category}`)
  const groupLabel = (group: string) => featureGroupLabel(tAdmin, group)
  const matcher = featureSearchMatcher(query, (row) => [
    tAdmin(`features.${row.key}.title`),
    tAdmin(`features.${row.key}.description`),
    categoryLabel(row.category),
    ...(row.group ? [groupLabel(row.group)] : []),
    ...(row.parentKey ? [tAdmin(`features.${row.parentKey}.title`)] : []),
  ])
  const results = matcher ? filterFeatureTree(sections, matcher) : null
  const home = sections.find((section) => section.category === tab) ?? sections[0]
  const countOn = (section: FeatureTreeSection | undefined) =>
    tAdmin('setup.features.countOn', { n: section?.visibleOn ?? 0, total: section?.visibleTotal ?? 0 })

  const renderRow = (node: FeatureTreeNode, compact: boolean, hintCount: number) => {
    const key = node.row.key
    const { reason, tone } = featureRowReason({
      node,
      hintCount,
      state,
      t: (messageKey, params) => tAdmin(messageKey, params),
    })
    return (
      <FeatureRow
        key={key}
        icon={FEATURE_ICONS[key] ?? Puzzle}
        title={tAdmin(`features.${key}.title`)}
        description={tAdmin(`features.${key}.description`)}
        on={node.on}
        blocked={false}
        compact={compact}
        reason={reason}
        reasonTone={tone}
        busy={false}
        disabled={node.missingRequirements.length > 0}
        onToggle={() => onToggle(key, !state[key])}
        depth={node.depth}
      />
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t('features.title')}</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('features.description')}</p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput placeholder={tAdmin('setup.features.searchPlaceholder')} value={query} onValueChange={setQuery} />
        {results ? null : (
          <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{countOn(home)}</span>
        )}
      </div>
      <div role="tablist" aria-label={t('features.tabsAria')} className="flex flex-wrap gap-1.5">
        {sections.map((section) => {
          const active = !results && section.category === home?.category
          const matches = results?.find((result) => result.category === section.category)?.visibleTotal
          return (
            <button
              key={section.category}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setTab(section.category)
                setQuery('')
              }}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                active
                  ? 'border-teal-500 bg-teal-50 text-teal-800 dark:border-teal-400 dark:bg-teal-950/40 dark:text-teal-200'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
              )}
            >
              {categoryLabel(section.category)}
              {results ? <span className="ml-1 tabular-nums text-slate-400">{matches ?? 0}</span> : null}
            </button>
          )
        })}
      </div>
      {results ? (
        results.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
            {tAdmin('setup.features.noMatches', { query: query.trim() })}
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
              <FeatureTreePanel section={section} renderRow={renderRow} groupLabel={groupLabel} />
            </section>
          ))
        )
      ) : home ? (
        <div role="tabpanel" aria-label={categoryLabel(home.category)} className="space-y-4">
          {groupFeatureSections(home, FEATURE_GROUPS[home.category as FeatureCategory] ?? []).map(({ key, section }) => (
            <section key={key} className="space-y-2" aria-label={groupLabel(key)}>
              <h3 className="px-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{groupLabel(key)}</h3>
              <FeatureTreePanel section={section} renderRow={renderRow} groupLabel={groupLabel} />
            </section>
          ))}
        </div>
      ) : null}
    </div>
  )
}
