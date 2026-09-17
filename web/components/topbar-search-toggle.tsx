'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Search } from 'lucide-react'
import { GlobalSearch } from './global-search'

/**
 * Topbar-mode mobile search trigger (F-t11-014). Below lg the inline header
 * search is hidden, which left global search unreachable on mobile with no
 * trigger at all. This icon button opens the same search as an overlay
 * strip under the header; the desktop inline input owns lg and up, so the
 * trigger hides there. Button styling mirrors the notifications bell.
 */
export function TopbarSearchToggle() {
  const t = useTranslations('shell.globalSearch')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on outside tap / Escape, mirroring the search panel itself. The
  // ref covers the toggle too, so tapping it toggles instead of instantly
  // re-closing through this handler.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="shrink-0 lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={t('ariaLabel')}
        aria-expanded={open}
        className="relative grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        <Search size={17} />
      </button>
      {open ? (
        <div className="absolute inset-x-0 top-full z-50 border-b border-slate-200 bg-white px-3 py-2 shadow-lg dark:border-slate-800 dark:bg-slate-900">
          <GlobalSearch className="w-full" />
        </div>
      ) : null}
    </div>
  )
}
