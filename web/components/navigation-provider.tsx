'use client'

// Supplies a client-side navigate fn to @openbooks/ui's UrlDrawer and the
// shared report overlay store. Overlay-only chrome (report drill, register,
// txn flyout) is a replaceState — it must not re-run a force-dynamic report
// loader. Record drawers that own `open` on the server still router.push.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { DrawerNavigateContext } from '@openbooks/ui'
import { isOverlayOnlyHrefChange } from '../lib/report-overlay'

export type ReportOverlayApi = {
  search: string
  pathname: string
  replace: (href: string) => void
  navigate: (href: string) => void
  beginReload: () => void
  reloadPending: boolean
}

const ReportOverlayContext = createContext<ReportOverlayApi | null>(null)

export function useReportOverlay(): ReportOverlayApi {
  const ctx = useContext(ReportOverlayContext)
  if (!ctx) throw new Error('useReportOverlay requires NavigationProvider')
  return ctx
}

export function useReportOverlayOptional(): ReportOverlayApi | null {
  return useContext(ReportOverlayContext)
}

export function NavigationProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname() ?? '/'
  const nextParams = useSearchParams()
  const nextSearch = nextParams.toString()
  const [overlaySearch, setOverlaySearch] = useState<string | null>(null)
  const [reloadPending, setReloadPending] = useState(false)

  // Next committed a real navigation — adopt its search as truth and drop
  // the overlay snapshot so a period change cannot keep a stale drill open.
  const nextKey = `${pathname}?${nextSearch}`
  const [prevNextKey, setPrevNextKey] = useState(nextKey)
  if (prevNextKey !== nextKey) {
    setPrevNextKey(nextKey)
    setOverlaySearch(null)
    setReloadPending(false)
  }

  const liveSearch = overlaySearch ?? nextSearch

  const replaceOverlay = useCallback((href: string) => {
    const url = new URL(href, window.location.origin)
    const next = url.search.startsWith('?') ? url.search.slice(1) : url.search
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`)
    setOverlaySearch(next)
  }, [])

  const navigate = useCallback((href: string) => {
    const current = `${pathname}${liveSearch ? `?${liveSearch}` : ''}`
    if (typeof window !== 'undefined' && isOverlayOnlyHrefChange(current, href)) {
      replaceOverlay(href)
      return
    }
    setReloadPending(true)
    router.push(href as never)
  }, [liveSearch, pathname, replaceOverlay, router])

  const beginReload = useCallback(() => setReloadPending(true), [])

  const api = useMemo<ReportOverlayApi>(() => ({
    search: liveSearch,
    pathname,
    replace: replaceOverlay,
    navigate,
    beginReload,
    reloadPending,
  }), [beginReload, liveSearch, navigate, pathname, reloadPending, replaceOverlay])

  return (
    <ReportOverlayContext.Provider value={api}>
      <DrawerNavigateContext.Provider value={navigate}>{children}</DrawerNavigateContext.Provider>
    </ReportOverlayContext.Provider>
  )
}

export function ReportReloadIndicator() {
  const overlay = useReportOverlayOptional()
  if (!overlay?.reloadPending) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-teal-600/20"
    >
      <div className="h-full w-1/3 animate-pulse bg-teal-600" />
    </div>
  )
}
