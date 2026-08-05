'use client'

// Reusable from/to date-range filter for server-rendered list pages. Writes ISO
// dates (YYYY-MM-DD) to URL params (default `from`/`to`) via router.replace,
// preserving every other param and resetting pagination. Consume server-side as
// `col >= from::date` and `col < to::date + interval '1 day'` (end-inclusive).

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { X } from 'lucide-react'

export function DateRangeFilter({
  fromKey = 'from',
  toKey = 'to',
  fromLabel,
  toLabel,
  clearLabel = 'Clear dates',
  pageParamKey = 'page',
  defaultFrom,
  defaultTo,
  clearable = true,
}: {
  fromKey?: string
  toKey?: string
  fromLabel: string
  toLabel: string
  clearLabel?: string
  pageParamKey?: string
  /** Values displayed when the corresponding URL key is absent. */
  defaultFrom?: string
  defaultTo?: string
  /** Required-period controls can suppress the clear affordance. */
  clearable?: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const rawFrom = sp.get(fromKey)
  const rawTo = sp.get(toKey)
  const from = rawFrom ?? defaultFrom ?? ''
  const to = rawTo ?? defaultTo ?? ''

  function apply(next: URLSearchParams) {
    next.delete(pageParamKey)
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname)
  }
  function set(key: string, value: string) {
    const next = new URLSearchParams(sp.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    apply(next)
  }
  function clear() {
    const next = new URLSearchParams(sp.toString())
    next.delete(fromKey)
    next.delete(toKey)
    apply(next)
  }

  const inputCls =
    'h-8 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 [color-scheme:light] focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:[color-scheme:dark]'

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="date"
        aria-label={fromLabel}
        value={from}
        max={to || undefined}
        onChange={(e) => set(fromKey, e.target.value)}
        className={inputCls}
      />
      <span className="text-slate-400 dark:text-slate-500">–</span>
      <input
        type="date"
        aria-label={toLabel}
        value={to}
        min={from || undefined}
        onChange={(e) => set(toKey, e.target.value)}
        className={inputCls}
      />
      {clearable && (rawFrom || rawTo) && (
        <button
          type="button"
          onClick={clear}
          aria-label={clearLabel}
          className="grid h-6 w-6 place-items-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}
