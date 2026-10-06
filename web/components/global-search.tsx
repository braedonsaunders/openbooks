'use client'

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Search, CornerDownLeft, Loader2, X } from 'lucide-react'
import { cn } from '@openbooks/ui'
import { NavIcon, type SidebarNavGroup } from './sidebar-nav'
import { relatedPartyHref } from './related-party-link'
import { ViewTabsContext } from './module-home/navigation-context'
import { buildPageIndex, searchPages, type PageSearchHit } from '../lib/nav/page-search'
import { readRecents, rememberRecent, writeRecents, type StoredRecent } from '../lib/search-recent'
import { statusLabel } from '../lib/status-label'
import type { RecentRef, SearchBadge, SearchGroup, SearchHit, SearchResponse } from '../lib/search-types'

type Hit = Omit<SearchHit, 'type'> & { type: SearchHit['type'] | 'page' }
type Group = { type: string; labelKey: string; hits: Hit[] }

/** Results that open a page rather than a record drawer over the current page. */
const PAGE_TYPES = new Set<Hit['type']>(['page', 'report', 'setting', 'help', 'dashboard'])

/** Split `text` around the first case-insensitive occurrence of `q` to bold the match. */
function highlight(text: string, q: string) {
  if (!q) return text
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-transparent font-semibold text-teal-700 dark:text-teal-300">
        {text.slice(i, i + q.length)}
      </mark>
      {text.slice(i + q.length)}
    </>
  )
}

function pageHit(page: PageSearchHit): Hit {
  return {
    id: page.href,
    type: 'page',
    title: page.title,
    subtitle: page.trail.length ? page.trail.join(' › ') : undefined,
    href: page.href,
    iconKey: page.iconKey,
  }
}

export function GlobalSearch({
  className,
  navGroups,
  recentScope,
}: {
  className?: string
  navGroups: readonly SidebarNavGroup[]
  /** The signed-in user in the current organization; recents never cross either. */
  recentScope: string
}) {
  const t = useTranslations('shell.globalSearch')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const pathname = usePathname() ?? '/'
  const searchParams = useSearchParams()
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [res, setRes] = useState<SearchResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [active, setActive] = useState(0)
  const [recentHits, setRecentHits] = useState<Hit[] | null>(null)
  const [recentFailed, setRecentFailed] = useState(false)
  const tabGroups = useContext(ViewTabsContext)?.groups

  // Pages come from the menu the shell already resolved for this reader, so
  // they answer instantly and never include a page the menu hides.
  const pageIndex = useMemo(() => buildPageIndex(navGroups, tabGroups), [navGroups, tabGroups])
  const pageQuery = q.trim()
  const searching = pageQuery.length >= 2
  const pageGroup: Group | null = useMemo(() => {
    if (pageQuery.length < 2) return null
    const hits = searchPages(pageIndex, pageQuery).map(pageHit)
    return hits.length ? { type: 'page', labelKey: 'pages', hits } : null
  }, [pageIndex, pageQuery])
  // A report or setting that is also a menu page shows once, as the page.
  const pageHrefs = new Set(pageGroup?.hits.map((hit) => hit.href) ?? [])
  const serverGroups: Group[] = (res?.groups ?? []).map((group: SearchGroup) => ({
    ...group,
    hits: group.hits.filter((hit) => !(PAGE_TYPES.has(hit.type) && pageHrefs.has(hit.href))),
  }))
  const groups: Group[] = searching
    ? [...(pageGroup ? [pageGroup] : []), ...serverGroups].filter((group) => group.hits.length > 0)
    : recentHits?.length
      ? [{ type: 'recent', labelKey: 'recent', hits: recentHits }]
      : []
  const total = groups.reduce((sum, group) => sum + group.hits.length, 0)
  const flat: Hit[] = groups.flatMap((g) => g.hits)

  const badgeLabel = (badge: SearchBadge) =>
    badge.kind === 'role'
      ? tCommon(`labels.${badge.value}` as never)
      : statusLabel(badge.value, (key) => tCommon(key as never), (key) => tCommon.has(key as never))

  // ⌘K / Ctrl+K focuses the search from anywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Close on outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        !inputRef.current?.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  // Reset the results while the query changes, during render (same committed
  // values, no extra render).
  const [prevQ, setPrevQ] = useState(q)
  if (prevQ !== q) {
    setPrevQ(q)
    setActive(0)
    setFailed(false)
    if (q.trim().length < 2) {
      setRes(null)
      setLoading(false)
    } else {
      setLoading(true)
    }
  }

  // Debounced fetch.
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) return
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal })
        // A failed search is not an empty one: say so rather than showing
        // "no matches" for results that were never looked for.
        if (!r.ok) {
          setRes(null)
          setFailed(true)
          return
        }
        setRes((await r.json()) as SearchResponse)
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setRes(null)
          setFailed(true)
        }
      } finally {
        setLoading(false)
      }
    }, 180)
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [q])

  // Recently opened results, shown when the box opens empty. Pages resolve
  // here from the current menu; everything else resolves on the server under
  // the reader's current permissions, so nothing they can no longer open is
  // listed and every title is current.
  const showRecents = open && !searching
  useEffect(() => {
    if (!showRecents) return
    const stored = readRecents(recentScope)
    if (stored.length === 0) return
    const pagesByHref = new Map(pageIndex.map((page) => [page.href, page]))
    const serverRefs = stored.filter((entry): entry is RecentRef => entry.type !== 'page')
    const ctrl = new AbortController()
    ;(async () => {
      let resolved: SearchHit[] = []
      if (serverRefs.length > 0) {
        try {
          const r = await fetch('/api/search/recent', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ refs: serverRefs }),
            signal: ctrl.signal,
          })
          if (r.status === 400) {
            // The stored references are not ones search issues (an older
            // format, or edited storage); forget them rather than resend them.
            writeRecents(recentScope, stored.filter((entry) => entry.type === 'page'))
          } else if (!r.ok) {
            setRecentFailed(true)
          } else {
            resolved = ((await r.json()) as { hits: SearchHit[] }).hits
            setRecentFailed(false)
          }
        } catch (e) {
          if ((e as Error).name === 'AbortError') return
          setRecentFailed(true)
        }
      }
      const byRef = new Map(resolved.map((hit) => [`${hit.type}:${hit.id}`, hit as Hit]))
      setRecentHits(stored.flatMap((entry): Hit[] => {
        if (entry.type === 'page') {
          const page = pagesByHref.get(entry.id)
          return page ? [pageHit(page)] : []
        }
        const hit = byRef.get(`${entry.type}:${entry.id}`)
        return hit ? [hit] : []
      }))
    })()
    return () => ctrl.abort()
  }, [showRecents, recentScope, pageIndex])

  const go = useCallback(
    (hit: Hit | undefined) => {
      if (!hit) return
      setOpen(false)
      setQ('')
      setRes(null)
      setRecentHits(null)
      setRecentFailed(false)
      inputRef.current?.blur()
      const entry: StoredRecent = hit.type === 'page' ? { type: 'page', id: hit.href } : { type: hit.type, id: hit.id }
      writeRecents(recentScope, rememberRecent(readRecents(recentScope), entry))
      if (PAGE_TYPES.has(hit.type)) {
        router.push(hit.href as never)
        return
      }
      router.push(
        (hit.type === 'contact'
          ? relatedPartyHref(pathname, searchParams.toString(), hit.id)
          : hit.href) as never,
        { scroll: false },
      )
    },
    [pathname, recentScope, router, searchParams],
  )

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
      return
    }
    if (!flat.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (a + 1) % flat.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (a - 1 + flat.length) % flat.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(flat[active])
    }
  }

  const showPanel = open && (searching || total > 0 || (showRecents && recentFailed))
  let idx = -1

  return (
    <div className={cn('relative', className)}>
      <div className="relative">
        <Search
          size={15}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400 dark:text-slate-500"
        />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t('placeholder')}
          aria-label={t('ariaLabel')}
          className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pr-16 pl-9 text-sm text-slate-900 transition-colors placeholder:text-slate-400 hover:border-slate-300 focus:border-teal-400 focus:bg-white focus:ring-2 focus:ring-teal-500/20 focus:outline-none dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-teal-500 dark:focus:bg-slate-900"
        />
        <div className="pointer-events-none absolute top-1/2 right-2.5 flex -translate-y-1/2 items-center gap-1">
          {loading ? (
            <Loader2 size={14} className="animate-spin text-slate-400" />
          ) : q ? (
            <button
              type="button"
              onClick={() => {
                setQ('')
                setRes(null)
                setFailed(false)
                inputRef.current?.focus()
              }}
              className="pointer-events-auto rounded p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              aria-label={t('clear')}
            >
              <X size={14} />
            </button>
          ) : (
            <kbd className="hidden rounded border border-slate-200 bg-white px-1.5 py-0.5 font-sans text-[10px] font-medium text-slate-600 sm:inline dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
              ⌘K
            </kbd>
          )}
        </div>
      </div>

      {showPanel ? (
        <div
          ref={panelRef}
          className="absolute top-[calc(100%+6px)] left-0 z-50 max-h-[70vh] w-full min-w-[22rem] overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        >
          {total > 0 ? (
            <>
              {groups.map((group) => (
                <div key={group.type} className="mb-1 last:mb-0">
                  <div className="px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                    {t(`groups.${group.labelKey}` as never)}
                  </div>
                  {group.hits.map((hit) => {
                    idx++
                    const isActive = idx === active
                    const myIdx = idx
                    return (
                      <button
                        key={`${hit.type}-${hit.id}`}
                        type="button"
                        onMouseEnter={() => setActive(myIdx)}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          go(hit)
                        }}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors',
                          isActive ? 'bg-teal-50 dark:bg-teal-950/50' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
                        )}
                      >
                        <span
                          className={cn(
                            'grid h-7 w-7 shrink-0 place-items-center rounded-md',
                            isActive
                              ? 'bg-white text-teal-600 dark:bg-slate-900 dark:text-teal-300'
                              : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
                          )}
                        >
                          <NavIcon iconKey={hit.iconKey} size={15} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm text-slate-900 dark:text-slate-100">
                              {highlight(hit.title, q.trim())}
                            </span>
                            {hit.badge ? (
                              <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                                {badgeLabel(hit.badge)}
                              </span>
                            ) : null}
                          </span>
                          {hit.subtitle ? (
                            <span className="truncate text-xs text-slate-500 dark:text-slate-400">{hit.subtitle}</span>
                          ) : null}
                        </span>
                        {hit.amount ? (
                          <span className="shrink-0 font-mono text-xs tabular-nums text-slate-600 dark:text-slate-300">
                            {hit.amount}
                          </span>
                        ) : null}
                        {isActive ? (
                          <CornerDownLeft size={13} className="shrink-0 text-teal-500 dark:text-teal-400" />
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              ))}
              <div className="mt-1 flex items-center justify-between border-t border-slate-100 px-2 py-1.5 text-[11px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <span>
                  <kbd className="font-sans">↑↓</kbd> {t('navigate')}&nbsp;&nbsp;<kbd className="font-sans">↵</kbd> {t('open')}&nbsp;&nbsp;
                  <kbd className="font-sans">esc</kbd> {t('close')}
                </span>
                {searching ? <span>{t('resultCount', { count: total })}</span> : null}
              </div>
            </>
          ) : loading ? (
            <div className="flex items-center gap-2 px-3 py-6 text-sm text-slate-400">
              <Loader2 size={15} className="animate-spin" /> {t('searching')}
            </div>
          ) : failed || (!searching && recentFailed) ? (
            <div role="alert" className="px-3 py-6 text-center text-sm text-amber-700 dark:text-amber-300">
              {searching ? t('failed') : t('recentFailed')}
            </div>
          ) : (
            <div className="px-3 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
              {t('noMatches', { query: q.trim() })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
