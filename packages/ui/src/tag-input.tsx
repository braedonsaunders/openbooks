'use client'

// TagInput — the one chip/tag multi-value text input. A row of removable
// chips plus a type-ahead over a provided option list, with free entry for
// values the list doesn't know yet. Raw JSON is never an acceptable UI, so
// any string-array configuration field renders through this control.
//
// Behaviour:
//   • Typing filters the option list (case/whitespace-insensitive); already
//     selected values are hidden from the suggestions.
//   • Enter (or comma) commits the highlighted suggestion, or — when free
//     entry is allowed — the typed text itself.
//   • Backspace in an empty input removes the last chip; every chip also has
//     an explicit remove button.
//   • The suggestion list is portaled + fixed-positioned from the control so
//     it floats above drawers and overflow containers (same pattern as
//     SearchSelect).
//
// Values are plain strings (what gets stored); options may carry a separate
// display label but usually value === label.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from './utils'

export type TagOption = {
  value: string
  label?: string
}

/** Case- and whitespace-insensitive identity, matching how free-text values
 *  (e.g. job titles) are compared by the domain engines. */
function normalizeTag(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function TagInput({
  value,
  onChange,
  options = [],
  placeholder,
  ariaLabel,
  id,
  disabled = false,
  allowNew = true,
  className,
}: {
  /** Selected values, in display order. */
  value: string[]
  onChange: (next: string[]) => void
  /** Type-ahead suggestions. Free entry stays available unless `allowNew` is off. */
  options?: TagOption[]
  placeholder?: string
  ariaLabel?: string
  id?: string
  disabled?: boolean
  /** Allow committing typed text that is not in `options`. */
  allowNew?: boolean
  className?: string
}) {
  const t = useTranslations('ui.tagInput')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [mounted, setMounted] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = `${useMemo(() => Math.random().toString(36).slice(2, 9), [])}-taglist`

  // Portaled dropdown anchored to the control (floats above drawer overflow).
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  function place() {
    const r = wrapRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: r.left, width: r.width })
  }

  useEffect(() => setMounted(true), [])

  const selectedKeys = useMemo(() => new Set(value.map(normalizeTag)), [value])

  const filtered = useMemo(() => {
    const q = normalizeTag(query)
    return options.filter((o) => {
      if (selectedKeys.has(normalizeTag(o.value))) return false
      if (!q) return true
      return normalizeTag(o.label ?? o.value).includes(q) || normalizeTag(o.value).includes(q)
    })
  }, [options, query, selectedKeys])

  const trimmedQuery = query.replace(/\s+/g, ' ').trim()
  const queryIsNew =
    allowNew &&
    trimmedQuery !== '' &&
    !selectedKeys.has(normalizeTag(trimmedQuery)) &&
    !filtered.some((o) => normalizeTag(o.value) === normalizeTag(trimmedQuery))
  // Row indices: 0..filtered.length-1 are suggestions; the optional trailing
  // row adds the typed text itself.
  const rowCount = filtered.length + (queryIsNew ? 1 : 0)

  function add(tag: string) {
    const clean = tag.replace(/\s+/g, ' ').trim()
    if (!clean || selectedKeys.has(normalizeTag(clean))) return
    onChange([...value, clean])
    setQuery('')
    setHighlight(0)
  }

  function remove(tag: string) {
    onChange(value.filter((v) => v !== tag))
    inputRef.current?.focus()
  }

  function commitHighlighted() {
    if (highlight < filtered.length && filtered[highlight]) add(filtered[highlight].value)
    else if (queryIsNew) add(trimmedQuery)
  }

  function openMenu() {
    if (disabled) return
    place()
    setOpen(true)
  }

  // Click-outside closes (the dropdown is portaled, so check both trees).
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      const target = e.target as Node
      if (wrapRef.current?.contains(target) || listRef.current?.parentElement?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Keep the dropdown anchored while open.
  useEffect(() => {
    if (!open) return
    place()
    const onMove = () => place()
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])

  useEffect(() => {
    if (highlight >= rowCount) setHighlight(Math.max(0, rowCount - 1))
  }, [highlight, rowCount])

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) openMenu()
      setHighlight((h) => Math.min(h + 1, Math.max(0, rowCount - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter' || e.key === ',') {
      if (open || trimmedQuery !== '') {
        e.preventDefault()
        commitHighlighted()
      }
    } else if (e.key === 'Backspace' && query === '' && value.length > 0) {
      onChange(value.slice(0, -1))
    } else if (e.key === 'Escape') {
      if (open) {
        e.stopPropagation()
        setOpen(false)
      }
    }
  }

  const showMenu = open && rowCount > 0

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <div
        onClick={() => {
          inputRef.current?.focus()
          openMenu()
        }}
        className={cn(
          'flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2 py-1.5 transition-shadow duration-150 dark:border-slate-700 dark:bg-slate-900',
          'focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-500/40',
          disabled && 'cursor-not-allowed bg-slate-50 opacity-70 dark:bg-slate-800',
        )}
      >
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex max-w-full items-center gap-1 rounded-md bg-teal-50 py-0.5 pr-1 pl-2 text-sm text-teal-900 dark:bg-teal-950/60 dark:text-teal-200"
          >
            <span className="truncate">{tag}</span>
            <button
              type="button"
              disabled={disabled}
              aria-label={t('remove', { tag })}
              onClick={(e) => {
                e.stopPropagation()
                remove(tag)
              }}
              className="grid h-4.5 w-4.5 shrink-0 place-items-center rounded text-teal-700/70 hover:bg-teal-100 hover:text-teal-900 focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:outline-none dark:text-teal-300/70 dark:hover:bg-teal-900 dark:hover:text-teal-100"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={showMenu}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showMenu ? `${listId}-${highlight}` : undefined}
          aria-label={ariaLabel}
          disabled={disabled}
          value={query}
          placeholder={value.length === 0 ? (placeholder ?? t('placeholder')) : undefined}
          onChange={(e) => {
            setQuery(e.target.value)
            setHighlight(0)
            openMenu()
          }}
          onFocus={openMenu}
          onKeyDown={onKeyDown}
          // 16px below sm — anything smaller makes iOS Safari zoom on focus.
          className="h-7 min-w-24 flex-1 bg-transparent text-base text-slate-900 outline-none placeholder:text-slate-400 sm:text-sm dark:text-slate-100 dark:placeholder:text-slate-500"
        />
      </div>

      {mounted && showMenu && pos
        ? createPortal(
            <div
              data-ui-overlay
              style={{ position: 'fixed', top: pos.top, left: pos.left, width: Math.max(pos.width, 208) }}
              className="z-[60] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900"
            >
              <ul ref={listRef} id={listId} role="listbox" className="max-h-56 overflow-y-auto py-1">
                {filtered.map((o, i) => (
                  <li key={o.value} role="presentation">
                    <button
                      type="button"
                      role="option"
                      id={`${listId}-${i}`}
                      aria-selected={i === highlight}
                      onMouseEnter={() => setHighlight(i)}
                      // mousedown, not click: keeps focus in the input.
                      onMouseDown={(e) => {
                        e.preventDefault()
                        add(o.value)
                      }}
                      className={cn(
                        'flex h-9 w-full items-center px-3 text-left text-sm text-slate-700 dark:text-slate-200',
                        i === highlight && 'bg-teal-50 dark:bg-teal-950/50',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{o.label ?? o.value}</span>
                    </button>
                  </li>
                ))}
                {queryIsNew ? (
                  <li role="presentation">
                    <button
                      type="button"
                      role="option"
                      id={`${listId}-${filtered.length}`}
                      aria-selected={highlight === filtered.length}
                      onMouseEnter={() => setHighlight(filtered.length)}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        add(trimmedQuery)
                      }}
                      className={cn(
                        'flex h-9 w-full items-center px-3 text-left text-sm text-teal-700 dark:text-teal-300',
                        highlight === filtered.length && 'bg-teal-50 dark:bg-teal-950/50',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{t('add', { value: trimmedQuery })}</span>
                    </button>
                  </li>
                ) : null}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
