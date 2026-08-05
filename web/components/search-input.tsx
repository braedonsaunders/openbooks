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
  const urlValue = search.get(paramKey) ?? ''
  const [edit, setEdit] = useState(() => createSearchInputEditState(urlValue))
  const [navigationPending, startTransition] = useTransition()
  const value = edit.value

  useEffect(() => {
    setEdit((current) => reconcileSearchInputUrl(current, urlValue, navigationPending))
  }, [navigationPending, urlValue])

  useEffect(() => {
    const handle = setTimeout(() => {
      // No-op when the input already matches the URL (mount, external URL
      // change) — navigating anyway would strip the page param and reset
      // deep-linked/refreshed pagination back to page 1.
      if (value === (search.get(paramKey) ?? '')) return
      const next = new URLSearchParams(search.toString())
      if (value) next.set(paramKey, value)
      else next.delete(paramKey)
      // Reset to page 1 when search changes
      next.delete(pageParamKey)
      const qs = next.toString()
      // Wrap the navigation in a transition so the App Router keeps the current
      // page (and this input's focus) mounted while the new RSC streams in,
      // instead of swapping in loading.tsx — otherwise the field loses focus on
      // every keystroke and you have to click back in. `scroll: false` keeps the
      // list from jumping to the top while filtering.
      startTransition(() => {
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
      })
    }, 250)
    return () => clearTimeout(handle)
  }, [pageParamKey, paramKey, pathname, router, search, startTransition, value])

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
