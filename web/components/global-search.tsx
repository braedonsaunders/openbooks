'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Search, CornerDownLeft, Loader2, X } from 'lucide-react'
import { cn } from '@openbooks/ui'
import { NavIcon } from './sidebar-nav'
import { relatedPartyHref } from './related-party-link'

type Hit = {
  id: string
  type: string
  title: string
  subtitle?: string
  href: string
  iconKey: string
  badge?: string
  amount?: string
}
type Group = { type: string; labelKey: string; hits: Hit[] }
type Response = { q: string; groups: Group[]; total: number }

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

export function GlobalSearch({ className }: { className?: string }) {
  const t = useTranslations('shell.globalSearch')
  const router = useRouter()
  const pathname = usePathname() ?? '/'
  const searchParams = useSearchParams()
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [res, setRes] = useState<Response | null>(null)
  const [active, setActive] = useState(0)

  const flat: Hit[] = res ? res.groups.flatMap((g) => g.hits) : []

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

  // Debounced fetch.
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setRes(null)
      setLoading(false)
      return
    }
    setLoading(true)
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal })
        if (!r.ok) throw new Error('search failed')
        const data = (await r.json()) as Response
        setRes(data)
        setActive(0)
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setRes({ q: term, groups: [], total: 0 })
      } finally {
        setLoading(false)
      }
    }, 180)
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [q])

  const go = useCallback(
    (hit: Hit | undefined) => {
      if (!hit) return
      setOpen(false)
      setQ('')
      setRes(null)
      inputRef.current?.blur()
      router.push(
        (hit.type === 'contact'
          ? relatedPartyHref(pathname, searchParams.toString(), hit.id)
          : hit.href) as never,
        { scroll: false },
      )
    },
    [pathname, router, searchParams],
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

  const showPanel = open && q.trim().length >= 2
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
                inputRef.current?.focus()
              }}
              className="pointer-events-auto rounded p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              aria-label={t('clear')}
            >
              <X size={14} />
            </button>
          ) : (
            <kbd className="hidden rounded border border-slate-200 bg-white px-1.5 py-0.5 font-sans text-[10px] font-medium text-slate-400 sm:inline dark:border-slate-700 dark:bg-slate-900 dark:text-slate-500">
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
          {res && res.total > 0 ? (
            <>
              {res.groups.map((group) => (
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
                              <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 capitalize dark:bg-slate-800 dark:text-slate-400">
                                {hit.badge}
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
                <span>{t('resultCount', { count: res.total })}</span>
              </div>
            </>
          ) : loading ? (
            <div className="flex items-center gap-2 px-3 py-6 text-sm text-slate-400">
              <Loader2 size={15} className="animate-spin" /> {t('searching')}
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
