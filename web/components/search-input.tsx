'use client'

import { useEffect, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Search, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Input, cn } from '@openbooks/ui'
import {
  applySearchInputEdit,
  createSearchInputEditState,
  reconcileSearchInputUrl,
} from '../lib/search-input-state'
import { isReportOverlayParam } from '../lib/report-overlay'
import { useReportOverlayOptional } from './navigation-provider'

export function SearchInput({
  placeholder,
  paramKey = 'q',
  pageParamKey = 'page',
  className,
}: {
  placeholder?: string
  paramKey?: string
  /** Pagination param to reset when the search changes (sub-tables use prefixed params). */
  pageParamKey?: string
  className?: string
}) {
  const t = useTranslations('ui.search')
  const pathname = usePathname()
  const router = useRouter()
  const search = useSearchParams()
  const overlay = useReportOverlayOptional()
  const liveSearch = overlay?.search ?? search.toString()
  const liveParams = new URLSearchParams(liveSearch)
  const urlValue = liveParams.get(paramKey) ?? ''
  const overlayNav = Boolean(overlay && isReportOverlayParam(paramKey))
  const [edit, setEdit] = useState(() => createSearchInputEditState(urlValue))
  const [navigationPending, startTransition] = useTransition()
  // Reconcile the edit buffer with the URL during render (same committed
  // value, no extra render). `reconcileSearchInputUrl` returns the previous
  // state by reference when nothing changed, so this settles after one pass.
  const reconciledEdit = reconcileSearchInputUrl(edit, urlValue, navigationPending)
  if (reconciledEdit !== edit) setEdit(reconciledEdit)
  const value = edit.value

  useEffect(() => {
    const handle = setTimeout(() => {
      // No-op when the input already matches the URL (mount, external URL
      // change) — navigating anyway would strip the page param and reset
      // deep-linked/refreshed pagination back to page 1.
      if (value === (new URLSearchParams(liveSearch).get(paramKey) ?? '')) return
      const next = new URLSearchParams(liveSearch)
      if (value) next.set(paramKey, value)
      else next.delete(paramKey)
      // Reset to page 1 when search changes
      next.delete(pageParamKey)
      const qs = next.toString()
      const href = qs ? `${pathname}?${qs}` : pathname
      // Overlay chrome (register search) must not re-run the page loader.
      // List search still goes through the App Router in a transition so
      // the field keeps focus while the new RSC streams in.
      if (overlayNav && overlay) {
        overlay.replace(href)
        return
      }
      startTransition(() => {
        router.replace(href, { scroll: false })
      })
    }, 250)
    return () => clearTimeout(handle)
  }, [liveSearch, overlay, overlayNav, pageParamKey, paramKey, pathname, router, startTransition, value])

  return (
    <div className={cn('relative w-full sm:w-72', className)}>
      <Search
        className="pointer-events-none absolute top-2 left-2.5 text-slate-400 dark:text-slate-500"
        size={16}
      />
      <Input
        type="search"
        placeholder={placeholder ?? t('placeholder')}
        value={value}
        onChange={(e) => setEdit(applySearchInputEdit(e.target.value, urlValue, navigationPending))}
        // Hide the browser's native search clear (×) — we render our own below,
        // so the native one would show a duplicate clear button.
        className="h-8 pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          aria-label={t('clearAria')}
          onClick={() => setEdit(applySearchInputEdit('', urlValue, navigationPending))}
          className="absolute top-2 right-2.5 text-slate-400 hover:text-slate-600 dark:text-slate-500"
        >
          <X size={16} />
        </button>
      ) : null}
    </div>
  )
}
