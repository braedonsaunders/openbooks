'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Check, ChevronDown } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn, Popover, SearchSelect } from '@openbooks/ui'
import { mergeHref } from '@/lib/list-params'

type FilterOption = { value: string; label: string; count?: number }

/**
 * Single-select filter rendered as a compact dropdown button. Collapses a
 * whole row of chips into one pill that shows the active selection inline, so
 * several filters + the search box fit on one toolbar row. Selecting an option
 * navigates (the param lives in the URL, same as before) — capability is
 * identical to the old chip row, just far denser.
 */
export function FilterChips({
  basePath,
  currentParams,
  paramKey,
  label,
  options,
  allLabel,
  defaultValue,
  pageParamKey = 'page',
  hideAll = false,
}: {
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  paramKey: string
  label: string
  options: FilterOption[]
  allLabel?: string
  /**
   * When set, this value is treated as the active selection while the URL
   * carries no param — i.e. the list defaults to this filter. Picking "All"
   * then navigates to an explicit `all` sentinel (rather than clearing the
   * param) so the page can tell "show everything" apart from the default.
   */
  defaultValue?: string
  /** Pagination parameter reset when this filter changes. */
  pageParamKey?: string
  /** Hide the generic All option for controls such as sort selectors. */
  hideAll?: boolean
}) {
  const tLabels = useTranslations('common.labels')
  const [open, setOpen] = useState(false)
  const raw =
    typeof currentParams[paramKey] === 'string' ? (currentParams[paramKey] as string) : undefined
  const current = raw ?? defaultValue
  const active = options.find((o) => o.value === current)
  const allHref = mergeHref(basePath, currentParams, {
    [paramKey]: defaultValue ? 'all' : undefined,
    [pageParamKey]: 1,
  })
  const allActive = defaultValue ? current === 'all' : !current

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="start"
      className="min-w-[13rem] p-1"
      trigger={
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'inline-flex h-8 max-w-[16rem] items-center gap-1.5 rounded-md border px-3 text-sm transition-colors',
            active
              ? 'border-teal-300 bg-teal-50 text-teal-800 dark:bg-teal-950/50 dark:text-teal-300'
              : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:bg-slate-800/60',
          )}
        >
          <span
            className={cn(
              'shrink-0',
              active ? 'text-teal-700/70 dark:text-teal-300' : 'text-slate-500 dark:text-slate-400',
            )}
          >
            {active ? `${label}:` : label}
          </span>
          {active ? <span className="truncate font-semibold">{active.label}</span> : null}
          <ChevronDown
            size={14}
            className={cn(
              'ml-auto shrink-0 transition-transform',
              open && 'rotate-180',
              active ? 'text-teal-500' : 'text-slate-400 dark:text-slate-500',
            )}
          />
        </button>
      }
    >
      <div className="max-h-72 overflow-auto" role="listbox">
        {!hideAll ? (
          <FilterItem href={allHref} active={allActive} onSelect={() => setOpen(false)}>
            {allLabel ?? tLabels('all')}
          </FilterItem>
        ) : null}
        {options.map((opt) => (
          <FilterItem
            key={opt.value}
            href={mergeHref(basePath, currentParams, {
              [paramKey]: opt.value,
              [pageParamKey]: 1,
            })}
            active={current === opt.value}
            count={opt.count}
            onSelect={() => setOpen(false)}
          >
            {opt.label}
          </FilterItem>
        ))}
      </div>
    </Popover>
  )
}

/**
 * Searchable single-select filter for long option lists (accounts, parties…)
 * where a chip dropdown would be an unscrollable wall. Same URL-param contract
 * as FilterChips (value in the URL, pagination reset on change), but rendered
 * as the app's SearchSelect — typeahead on desktop, bottom sheet on mobile —
 * sized to sit on the same toolbar row as the chips.
 */
export function SearchSelectFilter({
  paramKey,
  label,
  options,
  allLabel,
  pageParamKey = 'page',
  resetParamKeys = [],
  className,
}: {
  paramKey: string
  label: string
  options: { value: string; label: string; hint?: string }[]
  allLabel?: string
  pageParamKey?: string
  /** Additional URL state that becomes invalid when this filter changes. */
  resetParamKeys?: string[]
  className?: string
}) {
  const tLabels = useTranslations('common.labels')
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const value = sp.get(paramKey) ?? ''

  function onChange(v: string) {
    const next = new URLSearchParams(sp.toString())
    if (v) next.set(paramKey, v)
    else next.delete(paramKey)
    next.delete(pageParamKey)
    for (const key of resetParamKeys) next.delete(key)
    const qs = next.toString()
    router.replace((qs ? `${pathname}?${qs}` : pathname) as any)
  }

  return (
    <SearchSelect
      value={value}
      onChange={onChange}
      options={options}
      clearable
      emptyLabel={allLabel ?? tLabels('all')}
      placeholder={label}
      ariaLabel={label}
      sheetTitle={label}
      searchable
      className={cn('w-52', className)}
      triggerClassName={cn(
        'h-8 rounded-md px-3 shadow-none',
        value
          ? 'border-teal-300 bg-teal-50 dark:border-teal-800 dark:bg-teal-950/50 [&>span]:font-semibold [&>span]:text-teal-800 dark:[&>span]:text-teal-300'
          : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:hover:border-slate-600 dark:hover:bg-slate-800/60 [&>span]:text-slate-700 dark:[&>span]:text-slate-200',
      )}
    />
  )
}

function FilterItem({
  href,
  active,
  count,
  onSelect,
  children,
}: {
  href: string
  active: boolean
  count?: number
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <Link
      href={href as any}
      onClick={onSelect}
      role="option"
      aria-selected={active}
      className={cn(
        'flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors',
        active
          ? 'bg-teal-50 font-medium text-teal-800 dark:bg-teal-950/50 dark:text-teal-300'
          : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60',
      )}
    >
      <Check size={14} className={cn('shrink-0', active ? 'text-teal-600' : 'text-transparent')} />
      <span className="flex-1 truncate">{children}</span>
      {typeof count === 'number' ? (
        <span
          className={cn(
            'shrink-0 text-xs tabular-nums',
            active ? 'text-teal-600' : 'text-slate-400 dark:text-slate-500',
          )}
        >
          {count}
        </span>
      ) : null}
    </Link>
  )
}
