'use client'

// SearchSelect — a slick, mobile-first searchable select / typeahead.
//   • Desktop: anchored dropdown with a search box + keyboard nav.
//   • Mobile (<lg): an iOS/Android-style bottom sheet that slides up, with a
//     big search field and large tap targets + safe-area padding.
// Animated (framer-motion), portal'd sheet, Esc + click-out + scroll-lock.
// Supports disabled options and optgroup-style headers (via SelectOption.group).
// This is the single dropdown implementation behind both the people picker and
// the generic <Select> — there are no native <select> dropdowns in the app.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import { cn } from './utils'

export type SelectOption = {
  value: string
  label: string
  hint?: string
  /** Rendered greyed-out and non-selectable. */
  disabled?: boolean
  /** Group header label (from <optgroup>); options sharing a group are batched. */
  group?: string
}

export function SearchSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  disabled = false,
  clearable = false,
  emptyLabel,
  sheetTitle,
  ariaLabel,
  className,
  triggerClassName,
  searchable,
  remote = false,
  loading = false,
  statusMessage,
  statusTone = 'muted',
  onSearchChange,
  invalid = false,
  id,
}: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  searchPlaceholder?: string
  disabled?: boolean
  /** Adds a first option for the empty value (e.g. "No site"). */
  clearable?: boolean
  emptyLabel?: string
  /** Title shown at the top of the mobile bottom sheet. */
  sheetTitle?: string
  ariaLabel?: string
  /** Classes for the outer wrapper (layout / width). */
  className?: string
  /** Classes for the trigger button (height / text size overrides). */
  triggerClassName?: string
  /** Force the search box on/off. Defaults to auto: shown when >7 options or any groups. */
  searchable?: boolean
  /** Preserve server ordering and forward search text instead of filtering stale local rows. */
  remote?: boolean
  /** Announces a remote lookup without disabling an already selected value. */
  loading?: boolean
  /** Remote error or refinement guidance rendered below the option rows. */
  statusMessage?: string
  /** Visual treatment for the remote status message. */
  statusTone?: 'muted' | 'error'
  /** Called when the in-menu search changes or resets. */
  onSearchChange?: (query: string) => void
  /** Renders the trigger in an error state. */
  invalid?: boolean
  id?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [isDesktop, setIsDesktop] = useState(true)
  const [mounted, setMounted] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setMounted(true)
    const mq = window.matchMedia('(min-width: 1024px)')
    const update = () => setIsDesktop(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  const allOptions = useMemo(
    () => (clearable ? [{ value: '', label: emptyLabel ?? 'None' }, ...options] : options),
    [clearable, emptyLabel, options],
  )
  const selected = options.find((o) => o.value === value)
  const showEmpty = clearable && value === '' && !!emptyLabel
  const display = selected?.label ?? (showEmpty ? emptyLabel : placeholder)
  const isPlaceholder = !selected && !showEmpty

  const showSearch = searchable ?? (allOptions.length > 7 || allOptions.some((o) => o.group))

  const filtered = useMemo(() => {
    if (remote) return allOptions
    const q = query.trim().toLowerCase()
    if (!q) return allOptions
    return allOptions.filter(
      (o) => o.label.toLowerCase().includes(q) || o.group?.toLowerCase().includes(q),
    )
  }, [allOptions, query, remote])

  function firstEnabled(items: SelectOption[], start: number) {
    if (start >= 0 && start < items.length && !items[start]?.disabled) return start
    const fwd = items.findIndex((o) => !o.disabled)
    return fwd === -1 ? 0 : fwd
  }

  function openMenu() {
    if (disabled) return
    setQuery('')
    onSearchChange?.('')
    setHighlight(
      firstEnabled(
        allOptions,
        allOptions.findIndex((o) => o.value === value),
      ),
    )
    setOpen(true)
    setTimeout(() => searchRef.current?.focus(), 60)
  }
  function choose(v: string) {
    onChange(v)
    setOpen(false)
  }

  // Click-outside (desktop).
  useEffect(() => {
    if (!open || !isDesktop) return
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, isDesktop])

  // Keyboard nav + scroll-lock on the mobile sheet.
  useEffect(() => {
    if (!open) return
    const nextEnabled = (from: number, dir: 1 | -1) => {
      let index = from
      while (true) {
        index += dir
        if (index < 0 || index >= filtered.length) return from
        if (!filtered[index]?.disabled) return index
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
      else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => nextEnabled(h, 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => nextEnabled(h, -1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const o = filtered[highlight]
        if (o && !o.disabled) {
          onChange(o.value)
          setOpen(false)
        }
      }
    }
    document.addEventListener('keydown', onKey)
    let restore: (() => void) | undefined
    if (!isDesktop) {
      const prev = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      restore = () => {
        document.body.style.overflow = prev
      }
    }
    return () => {
      document.removeEventListener('keydown', onKey)
      restore?.()
    }
  }, [filtered, highlight, isDesktop, onChange, open])

  const optionList = (
    <>
      <ul role="listbox" className="py-1">
        {filtered.length === 0 && !loading ? (
          <li
            role="option"
            aria-disabled="true"
            className="px-3 py-8 text-center text-sm text-slate-400 dark:text-slate-500"
          >
            No matches
          </li>
        ) : null}
        {filtered.map((o, i) => {
          const active = o.value === value
          const prevGroup = i > 0 ? filtered[i - 1]?.group : undefined
          const header = o.group && o.group !== prevGroup ? o.group : null
          return (
            <li key={o.value || `__opt-${i}`} role="presentation">
              {header ? (
                <div className="px-4 pt-2.5 pb-1 text-[11px] font-semibold tracking-wide text-slate-400 uppercase lg:px-3 dark:text-slate-500">
                  {header}
                </div>
              ) : null}
              <button
                type="button"
                role="option"
                aria-selected={active}
                disabled={o.disabled}
                onMouseEnter={() => !o.disabled && setHighlight(i)}
                onClick={() => !o.disabled && choose(o.value)}
                className={cn(
                  'flex h-12 w-full items-center gap-2.5 px-4 text-left text-[15px] transition-colors lg:h-9 lg:px-3 lg:text-sm',
                  o.disabled
                    ? 'cursor-not-allowed text-slate-300 dark:text-slate-600'
                    : i === highlight
                      ? 'bg-teal-50 dark:bg-teal-950/50'
                      : 'active:bg-slate-100 dark:active:bg-slate-700',
                  !o.disabled &&
                    (active
                      ? 'font-medium text-teal-900 dark:text-teal-300'
                      : 'text-slate-700 dark:text-slate-200'),
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {o.label}
                  {o.hint ? (
                    <span className="ml-1.5 text-xs text-slate-400 dark:text-slate-500">
                      {o.hint}
                    </span>
                  ) : null}
                </span>
                {active ? <Check size={17} className="shrink-0 text-teal-600" /> : null}
              </button>
            </li>
          )
        })}
      </ul>
      {loading || statusMessage ? (
        <div
          role={statusTone === 'error' ? 'alert' : 'status'}
          className={cn(
            'border-t border-slate-100 px-3 py-2 text-xs dark:border-slate-800',
            statusTone === 'error'
              ? 'text-red-600 dark:text-red-400'
              : 'text-slate-500 dark:text-slate-400',
          )}
        >
          {loading ? 'Searching…' : statusMessage}
        </div>
      ) : null}
    </>
  )

  const searchBox = (largeText: boolean) => (
    <div className="relative px-3 pt-3">
      <Search
        size={16}
        className="absolute top-1/2 left-6 -translate-y-1/2 text-slate-400 dark:text-slate-500"
      />
      <input
        ref={searchRef}
        value={query}
        onChange={(e) => {
          const next = e.target.value
          setQuery(next)
          onSearchChange?.(next)
          setHighlight(0)
        }}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
        aria-busy={loading || undefined}
        className={cn(
          'w-full rounded-lg border border-slate-200 bg-slate-50 pr-3 pl-9 transition outline-none focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-500/20 dark:border-slate-800 dark:bg-slate-900 dark:focus:bg-slate-900',
          // 16px below sm — anything smaller makes iOS Safari zoom on focus.
          largeText ? 'h-11 text-base' : 'h-9 text-base sm:text-sm',
        )}
      />
    </div>
  )

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <button
        type="button"
        id={id}
        onClick={() => (open ? setOpen(false) : openMenu())}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        className={cn(
          'flex h-10 w-full items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-left text-sm shadow-sm transition dark:border-slate-700 dark:bg-slate-900',
          'focus:border-teal-500 focus:ring-2 focus:ring-teal-500/25 focus:outline-none',
          disabled && 'cursor-not-allowed bg-slate-50 opacity-70 dark:bg-slate-800',
          open && 'border-teal-500 ring-2 ring-teal-500/25',
          invalid && 'border-red-400 focus:border-red-500 focus:ring-red-500/30',
          triggerClassName,
        )}
      >
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            isPlaceholder
              ? 'text-slate-400 dark:text-slate-500'
              : 'text-slate-800 dark:text-slate-100',
          )}
        >
          {display}
        </span>
        <ChevronDown
          size={16}
          className={cn(
            'shrink-0 text-slate-400 transition-transform dark:text-slate-500',
            open && 'rotate-180',
          )}
        />
      </button>

      {/* Desktop dropdown */}
      {open && isDesktop ? (
        <div className="absolute top-full left-0 z-50 mt-1.5 w-full min-w-[12rem] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900">
          {showSearch ? searchBox(false) : null}
          <div className={cn('max-h-64 overflow-y-auto', showSearch && 'mt-1')}>{optionList}</div>
        </div>
      ) : null}

      {/* Mobile bottom sheet */}
      {mounted && !isDesktop
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <div className="fixed inset-0 z-[60]">
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
                    onClick={() => setOpen(false)}
                  />
                  <motion.div
                    initial={{ y: '100%' }}
                    animate={{ y: 0 }}
                    exit={{ y: '100%' }}
                    transition={{ type: 'spring', damping: 34, stiffness: 340, mass: 0.8 }}
                    className="absolute inset-x-0 bottom-0 flex max-h-[82vh] flex-col rounded-t-2xl border-t border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
                  >
                    <div className="flex items-center justify-center pt-2.5">
                      <span className="h-1.5 w-10 rounded-full bg-slate-300" />
                    </div>
                    <div className="flex items-center justify-between px-4 pt-2 pb-1">
                      <span className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        {sheetTitle ?? 'Select'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setOpen(false)}
                        aria-label="Close"
                        className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                      >
                        <X size={18} />
                      </button>
                    </div>
                    {showSearch ? searchBox(true) : null}
                    <div className="mt-1 min-h-0 flex-1 overflow-y-auto pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                      {optionList}
                    </div>
                  </motion.div>
                </div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </div>
  )
}
