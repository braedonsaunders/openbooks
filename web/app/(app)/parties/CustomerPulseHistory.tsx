'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Skeleton } from '@openbooks/ui'
import { SearchInput } from '@/components/search-input'
import { Pagination } from '@/components/pagination'
import { readApiErrorMessage } from '@/lib/api-error'
import { customerPulseTimelineParams, type CustomerPulseTimelinePage } from '@/lib/customer-pulse-timeline-params'
import { PulseHistoryTable } from './PulseHistoryTable'

function pageKey(page: Pick<CustomerPulseTimelinePage, 'page' | 'perPage' | 'q' | 'dir'>) {
  return JSON.stringify([page.page, page.perPage, page.q, page.dir])
}

/** History pagination only reloads the history reader, keeping the drawer and
 * its financial snapshot mounted. Namespaced URL state preserves host filters. */
export function CustomerPulseHistory({ partyId, currency, initialPage, withheld }: {
  partyId: string
  currency: string
  initialPage: CustomerPulseTimelinePage
  withheld: boolean
}) {
  const t = useTranslations('crm.pulse')
  const tc = useTranslations('common')
  const search = useSearchParams()
  const params = customerPulseTimelineParams(Object.fromEntries(search))
  const key = pageKey(params)
  const [result, setResult] = useState({ key: pageKey(initialPage), data: initialPage })
  const [refusal, setRefusal] = useState<{ key: string; message: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const [draft, setDraft] = useState(params.q)
  const [urlQuery, setUrlQuery] = useState(params.q)
  if (urlQuery !== params.q) {
    setUrlQuery(params.q)
    setDraft(params.q)
  }
  const replace = (changes: Record<string, string | undefined>) => {
    const url = new URL(window.location.href)
    for (const [name, value] of Object.entries(changes)) {
      if (value) url.searchParams.set(name, value)
      else url.searchParams.delete(name)
    }
    window.history.replaceState(null, '', url)
  }
  useEffect(() => {
    if (draft === params.q) return
    const handle = setTimeout(() => {
      const url = new URL(window.location.href)
      if (draft) url.searchParams.set('pulseHistoryQ', draft)
      else url.searchParams.delete('pulseHistoryQ')
      url.searchParams.delete('pulseHistoryPage')
      window.history.replaceState(null, '', url)
    }, 250)
    return () => clearTimeout(handle)
  }, [draft, params.q])

  const page = params.page
  const perPage = params.perPage
  const q = params.q
  const dir = params.dir
  useEffect(() => {
    if (key === pageKey(initialPage) && retry === 0) return
    const controller = new AbortController()
    let active = true
    const query = new URLSearchParams({ pulseHistoryPage: String(page), pulseHistoryPerPage: String(perPage), pulseHistoryQ: q, pulseHistoryDir: dir })
    fetch(`/api/customers/${partyId}/pulse/timeline?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t('loadFailed')))
        return response.json() as Promise<CustomerPulseTimelinePage>
      })
      .then((data) => { if (active) { setResult({ key, data }); setRefusal(null) } })
      .catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return
        setRefusal({ key, message: error instanceof Error ? error.message : t('loadFailed') })
      })
    return () => { active = false; controller.abort() }
  }, [partyId, page, perPage, q, dir, key, initialPage, retry, t])

  const data = key === pageKey(initialPage) && retry === 0 ? initialPage : result.key === key ? result.data : null
  const error = refusal?.key === key ? refusal.message : null
  const toolbar = !withheld && <SearchInput value={draft} onValueChange={setDraft} />
  const pagingState = data ?? (result.data.q === q && result.data.dir === dir
    ? { ...result.data, page, perPage } : null)
  return <div className="space-y-3" aria-busy={!data && !error}>
    {toolbar}
    {error ? <div role="alert" className="rounded-xl border border-slate-200 p-4 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300"><p>{error}</p><Button variant="secondary" size="sm" className="mt-3" onClick={() => { setRefusal(null); setRetry((value) => value + 1) }}>{tc('actions.retry')}</Button></div>
      : data ? <PulseHistoryTable rows={data.rows} currency={currency} state={data} withheld={withheld} />
        : <Skeleton className="h-48 w-full rounded-xl" />}
    {!withheld && pagingState && !error && <Pagination basePath="" currentParams={{}} total={pagingState.total} page={pagingState.page} perPage={pagingState.perPage} onPageChange={(next) => replace({ pulseHistoryPage: String(next) })} />}
  </div>
}
