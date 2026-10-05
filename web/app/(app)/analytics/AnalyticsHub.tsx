'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { Activity, ArrowUpRight, Check, Clock, Gauge, Plus, ShieldAlert, Users, Wallet, Zap, Coins, Truck, type LucideIcon } from 'lucide-react'
import { Button, Drawer, PageHeader } from '@openbooks/ui'
import type { PageLayoutPrefs } from '@openbooks/schema'
import { RecordKindCard, RecordKindCards } from '../../../components/record-kind-cards'
import { RecordTabs } from '../../../components/module-home/record-tabs'
import { SearchInput } from '../../../components/search-input'
import { usePageLayout } from '../../../components/page-layout/use-page-layout'
import { ReportFilterBar } from '../reports/ReportFilterBar'
import type { AnalyticsPreview } from '../../../lib/analytics/dashboard-catalog'
import { AnalyticsCardChart } from './AnalyticsCardChart'
import { useAnalyticsPreviews } from './use-analytics-previews'

const ICONS: Record<string, LucideIcon> = { Activity, Coins, Wallet, Clock, Users, Truck, ShieldAlert, Zap, Gauge }
export type AnalyticsCard = { slug: string; href: string; title: string; desc: string; icon: string; pack: string; featureLabel?: string }
export type AnalyticsGroup = { key: string; label: string; cards: AnalyticsCard[] }

function LiveAnalyticsCard({ card, preview, error, onReady }: { card: AnalyticsCard; preview?: AnalyticsPreview; error?: string; onReady: (slug: string, visible: boolean) => void }) {
  const t = useTranslations('analytics.hub')
  const formatter = useFormatter()
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      onReady(card.slug, entries.some((entry) => entry.isIntersecting))
    }, { rootMargin: '160px' })
    if (element.current) observer.observe(element.current)
    return () => { observer.disconnect(); onReady(card.slug, false) }
  }, [card.slug, onReady])
  const Icon = ICONS[card.icon] ?? Activity
  return <div ref={element} data-analytics-card={card.slug} className="min-w-0">
    <RecordKindCard compact href={card.href} label={card.title} description={card.desc} icon={<Icon size={17} />} metadata={<div className="flex min-w-0 items-center gap-3"><span title={card.pack} className="max-w-40 truncate text-right text-[10px] font-medium text-slate-500 dark:text-slate-400">{card.pack}</span>{preview?.chart ? <AnalyticsCardChart chart={preview.chart} /> : null}</div>}>
      <div className="mt-3 w-full border-t border-slate-100 pt-3 dark:border-slate-800" aria-live="polite" aria-busy={!preview && !error}>
        {error ? <p className="min-h-20 text-sm text-amber-700 dark:text-amber-300">{error}</p> : preview?.metrics.length ? <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          {preview.metrics.map((metric, index) => <div key={`${metric.label}:${index}`} className="min-w-0">
            <dt className="mb-0.5 text-[10px] leading-4 text-slate-500 dark:text-slate-400">{metric.label}</dt>
            <dd title={metric.value} className="break-words text-lg font-semibold tracking-tight text-slate-900 tabular-nums dark:text-slate-100">{metric.value}</dd>
          </div>)}
        </dl> : preview ? null : <div className="grid min-h-20 grid-cols-2 gap-3" aria-label={t('loading')}>
          {[0, 1, 2, 3].map((index) => <div key={index} className="space-y-2 motion-safe:animate-pulse"><div className="h-3 w-20 rounded bg-slate-100 dark:bg-slate-800" /><div className="h-5 w-24 max-w-full rounded bg-slate-100 dark:bg-slate-800" /></div>)}
        </div>}
        {preview?.notice ? <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">{preview.notice}</p> : null}
        <div className="mt-3 flex items-end justify-between gap-3 text-[11px]">
          <span className="text-slate-400 dark:text-slate-500">{preview?.periodLabel ?? t('loading')}{preview ? <time className="ml-2" dateTime={preview.observedAt} title={formatter.dateTime(new Date(preview.observedAt), { dateStyle: 'medium', timeStyle: 'medium' })}>{t('calculatedAt', { time: formatter.dateTime(new Date(preview.observedAt), { hour: 'numeric', minute: '2-digit' }) })}</time> : null}</span>
          <span className="flex shrink-0 items-center gap-1 font-medium text-teal-700 dark:text-teal-300">{t('explore')}<ArrowUpRight size={14} /></span>
        </div>
      </div>
    </RecordKindCard>
  </div>
}

export function AnalyticsHub({ title, groups, initialLayout = {} }: { title: string; description: string; groups: AnalyticsGroup[]; initialLayout?: PageLayoutPrefs }) {
  const t = useTranslations('analytics.hub')
  const [query, setQuery] = useState('')
  const [libraryQuery, setLibraryQuery] = useState('')
  const [activeGroup, setActiveGroup] = useState('all')
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [ready, setReady] = useState<Set<string>>(new Set())
  const onReady = useCallback((slug: string, visible: boolean) => setReady((current) => {
    if (current.has(slug) === visible) return current
    const next = new Set(current)
    if (visible) next.add(slug)
    else next.delete(slug)
    return next
  }), [])
  const cards = useMemo(() => groups.flatMap((group) => group.cards), [groups])
  const defaultOrder = useMemo(() => cards.map((card) => card.slug), [cards])
  const layout = usePageLayout('analytics', initialLayout, defaultOrder)
  const search = useSearchParams()
  const periodQuery = new URLSearchParams()
  // Only shared dashboard filters travel into analytical queries. Search and
  // library state remain local and never change source data selection.
  for (const key of ['period', 'from', 'to', 'horizon']) {
    const value = search.get(key)
    if (value) periodQuery.set(key, value)
  }
  const qs = periodQuery.toString()
  const matches = (card: AnalyticsCard, text: string) => `${card.title} ${card.desc} ${card.pack} ${card.featureLabel ?? ''}`.toLocaleLowerCase().includes(text.trim().toLocaleLowerCase())
  const shown = groups.filter((group) => activeGroup === 'all' || activeGroup === group.key).map((group) => ({ ...group, cards: group.cards.filter((card) => !layout.hidden.has(card.slug) && matches(card, query)) })).filter((group) => group.cards.length)
  const previews = useAnalyticsPreviews(shown.flatMap((group) => group.cards.filter((card) => ready.has(card.slug)).map((card) => card.slug)), qs, refresh, t('loadError'))
  const libraryGroups = groups.map((group) => ({ ...group, cards: group.cards.filter((card) => matches(card, libraryQuery)) })).filter((group) => group.cards.length)
  const tabs = [{ key: 'all', label: t('all') }, ...groups.filter((group) => group.cards.length).map((group) => ({ key: group.key, label: group.label }))]

  return <div className="space-y-3">
    <PageHeader title={title} actions={<>
      <SearchInput size="md" value={query} onValueChange={setQuery} placeholder={t('searchPlaceholder')} className="w-full sm:w-80 sm:max-w-none" />
      <ReportFilterBar compact controls={{ period: true }} />
      <Button onClick={() => setLibraryOpen(true)}><Plus size={16} />{t('addAnalytics')}</Button>
    </>} />
    <RecordTabs label={t('browseGroups')} tabs={tabs} active={activeGroup} onChange={setActiveGroup}>
      <div className="space-y-4 pt-3">
        {Object.values(previews).some((preview) => preview.error) ? <Button variant="ghost" size="sm" onClick={() => setRefresh((value) => value + 1)}>{t('retryMetrics')}</Button> : null}
        {shown.length ? <div className="grid items-stretch gap-3 md:grid-cols-2 xl:grid-cols-3">
          {shown.flatMap((group) => group.cards).map((card) => <LiveAnalyticsCard key={card.slug} card={{ ...card, href: `${card.href}${qs ? `?${qs}` : ''}` }} preview={previews[card.slug]?.data} error={previews[card.slug]?.error} onReady={onReady} />)}
        </div> : <div className="rounded-xl border border-dashed border-slate-200 p-10 text-center dark:border-slate-800"><p className="text-sm text-slate-500">{query ? t('noMatches') : t('noneVisible')}</p><Button variant="outline" className="mt-4" onClick={() => setLibraryOpen(true)}>{t('addAnalytics')}</Button></div>}
      </div>
    </RecordTabs>
    <Drawer open={libraryOpen} onClose={() => setLibraryOpen(false)} size="md" title={t('libraryTitle')} description={t('libraryDescription')} bodyClassName="overflow-y-auto p-5">
      <div className="space-y-5">
        <SearchInput size="md" value={libraryQuery} onValueChange={setLibraryQuery} placeholder={t('searchPlaceholder')} className="w-full sm:w-full sm:max-w-none" />
        <div className="flex items-center justify-between gap-3"><span role="status" className="text-xs text-slate-500">{layout.saveState === 'saving' ? t('saving') : layout.saveState === 'error' ? t('unsaved') : t('saved')}</span><Button variant="ghost" size="sm" onClick={layout.reset}>{t('showAll')}</Button></div>
        {layout.saveError ? <div role="alert" className="rounded-lg border border-amber-200 p-3 text-sm text-amber-800 dark:text-amber-300">{layout.saveError}<Button variant="outline" size="sm" onClick={layout.retry} className="mt-2">{t('retry')}</Button></div> : null}
        {libraryGroups.length ? libraryGroups.map((group) => <RecordKindCards key={group.key} heading={group.label} gridClassName="grid-cols-1 md:grid-cols-1 xl:grid-cols-1" options={group.cards.map((card) => {
          const Icon = ICONS[card.icon] ?? Activity
          const selected = !layout.hidden.has(card.slug)
          return { value: card.slug, label: card.title, description: `${card.desc} · ${card.pack}`, icon: <Icon size={20} />, selected, metadata: <span className={`flex items-center gap-1 text-xs ${selected ? 'text-teal-700 dark:text-teal-300' : 'text-slate-400'}`}>{selected ? <Check size={14} /> : <Plus size={14} />}{selected ? t('visible') : t('hidden')}</span> }
        })} onChoose={layout.toggle} />) : <p className="text-sm text-slate-500">{t('noMatches')}</p>}
      </div>
    </Drawer>
  </div>
}
