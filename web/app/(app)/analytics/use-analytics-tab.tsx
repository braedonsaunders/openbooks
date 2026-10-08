'use client'

import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Skeleton } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../lib/api-error'
import { analyticsQueryString } from '../../../lib/analytics/query-params'
import type { AnalyticsSlug } from '../../../lib/analytics/dashboard-tabs'
import { useDocumentHidden } from '../../../lib/use-document-hidden'

type ReadMeta = { slug: string; tab: string; observedAt: string; query: string }
function metadata(data: unknown): ReadMeta | undefined {
  if (!data || typeof data !== 'object' || !('_analyticsRead' in data)) return
  const meta = data._analyticsRead
  if (meta && typeof meta === 'object' && 'slug' in meta && 'tab' in meta && 'observedAt' in meta && 'query' in meta && typeof meta.slug === 'string' && typeof meta.tab === 'string' && typeof meta.observedAt === 'string' && typeof meta.query === 'string' && Number.isFinite(Date.parse(meta.observedAt))) return meta as ReadMeta
}

/** The URL selects one cancellable detail read. Previously resolved tabs stay
 * available only until their source observation expires. Older periods and
 * superseded requests cannot overwrite the selected view. */
export function useAnalyticsTab<T extends { data: unknown }, K extends string>(slug: AnalyticsSlug, initial: T, tabs: readonly K[]) {
  const search = useSearchParams()
  const hidden = useDocumentHidden()
  const t = useTranslations('analytics.hub')
  const meta = metadata(initial.data)
  const enabled = meta?.slug === slug
  const [localTab, select] = useState<K>(tabs[0]!)
  const requested = search.get('tab') ?? meta?.tab
  const tab = enabled ? tabs.find((value) => value === requested) ?? tabs[0]! : localTab
  const query = analyticsQueryString(Object.fromEntries(search.entries()), slug)
  const key = `${query}:${tab}`
  const [attempt, retry] = useReducer((n: number) => n + 1, 0)
  const [refreshTick, refresh] = useReducer((n: number) => n + 1, 0)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  // The per-source read cache lives in refs and resets during render when a
  // new server observation arrives, so a superseded generation can never
  // be written by a late read; the effect below compares generations by
  // identity. Reading these refs during render is that deliberate reset.
  /* eslint-disable react-hooks/refs */
  const source = useRef<unknown>(undefined)
  const cache = useRef(new Map<string, { props?: T; until: number; error?: string }>())
  if (source.current !== initial.data) {
    source.current = initial.data
    cache.current = new Map([[`${meta?.query ?? query}:${meta?.tab ?? tab}`, { props: initial, until: Date.parse(meta?.observedAt ?? new Date().toISOString()) + 30_000 }]])
  }
  const generation = cache.current
  const entry = generation.get(key)
  /* eslint-enable react-hooks/refs */
  const ready = !enabled || Boolean(entry?.props)
  const error = entry?.error
  useEffect(() => {
    if (!enabled || hidden) return
    const cached = generation.get(key)
    let timer: number | undefined
    const schedule = (until: number) => {
      // Slow reads may finish after the source observation expires. Keep its
      // timestamp and wait a freshness window before another read, rather
      // than immediately looping on a value the shared cache cannot retain.
      timer = window.setTimeout(refresh, Math.max(1, until - Date.now()))
    }
    if (cached?.props && cached.until > Date.now()) {
      schedule(cached.until)
      return () => { if (timer !== undefined) window.clearTimeout(timer) }
    }
    const controller = new AbortController()
    if (!cached?.props) generation.delete(key)
    rerender()
    const load = async () => {
      try {
        const response = await fetch(`/api/analytics/dashboards/${slug}?${query}&tab=${encodeURIComponent(tab)}`, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t('loadError')))
        const value: unknown = await response.json()
        if (!value || typeof value !== 'object' || !('data' in value)) throw new Error(t('loadError'))
        if ('refusal' in value && typeof value.refusal === 'string' && value.refusal) throw new Error(value.refusal)
        const returned = metadata(value.data)
        if (returned?.slug !== slug || returned.tab !== tab || returned.query !== query) throw new Error(t('loadError'))
        if (!controller.signal.aborted) {
          const until = Date.parse(returned.observedAt) + 30_000
          generation.set(key, { props: value as T, until })
          schedule(until > Date.now() ? until : Date.now() + 30_000)
        }
      } catch (failure) {
        if (!controller.signal.aborted) generation.set(key, { until: 0, error: failure instanceof Error ? failure.message : t('loadError') })
      } finally { if (!controller.signal.aborted && cache.current === generation) rerender() }
    }
    void load()
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/refs -- the generation is the render-time cache identity above
  }, [enabled, hidden, key, query, attempt, slug, tab, t, generation, refreshTick])
  const setTab = (next: K) => {
    if (!tabs.includes(next)) return
    select(next)
    if (enabled) {
      const url = new URL(window.location.href)
      url.searchParams.set('tab', next)
      window.history.replaceState(null, '', url)
    }
  }
  return { props: enabled && entry?.props ? entry.props : initial, tab, setTab, loading: !ready && !error, error, retry: () => { generation.delete(key); retry() } }
}

export function AnalyticsTabContent({ loading, error, retry, children }: { loading: boolean; error?: string; retry: () => void; children: ReactNode }) {
  const t = useTranslations('analytics.hub')
  if (error) return <div role="alert" className="rounded-xl border border-amber-200 p-4 dark:border-amber-900"><p className="mb-3 text-sm text-amber-700 dark:text-amber-300">{error}</p><Button variant="secondary" onClick={retry}>{t('retryMetrics')}</Button></div>
  if (loading) return <div aria-busy="true" aria-label={t('loading')} className="grid gap-4 md:grid-cols-2">{[0, 1].map((n) => <Skeleton key={n} className="h-64 rounded-xl" />)}</div>
  return children
}
