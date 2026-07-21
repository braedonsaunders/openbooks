'use client'

import { useState } from 'react'
import { LayoutGrid, Eye, EyeOff, ChevronUp, ChevronDown, RotateCcw } from 'lucide-react'
import { Button, Popover, cn } from '@openbooks/ui'

export type LayoutMenuRow = {
  key: string
  label: string
  hidden: boolean
  /** Secondary text after the label (e.g. an account number). */
  detail?: string
  /** false = toggle-only row (no up/down arrows), e.g. a fixed vitals strip. */
  orderable?: boolean
}

/**
 * Customize-layout popover — the shared show/hide/reorder control for
 * cockpits, module homes, and rosters (eye toggles + up/down arrows + reset).
 * Rows come pre-ordered from usePageLayout; `orderable: false` rows render
 * without arrows and don't count toward first/last disabling. The list
 * scrolls, so it also works for long rosters (dozens of accounts).
 */
export function LayoutMenu({
  title,
  triggerLabel,
  resetLabel,
  rows,
  onToggle,
  onMove,
  onReset,
  size = 'sm',
}: {
  title: string
  triggerLabel: string
  resetLabel: string
  rows: LayoutMenuRow[]
  onToggle: (key: string) => void
  onMove: (key: string, dir: -1 | 1) => void
  onReset: () => void
  size?: 'sm' | 'xs'
}) {
  const [open, setOpen] = useState(false)
  const orderable = rows.filter((r) => r.orderable !== false)
  const firstKey = orderable[0]?.key
  const lastKey = orderable[orderable.length - 1]?.key
  const iconBtn =
    'grid h-6 w-6 place-items-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:hover:text-slate-200'
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-72 p-2"
      trigger={
        size === 'xs' ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={triggerLabel}
            title={triggerLabel}
            className="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <LayoutGrid size={14} />
          </button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            <LayoutGrid size={14} />
            {triggerLabel}
          </Button>
        )
      }
    >
      <div className="px-2 pt-1 pb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {title}
      </div>
      <ul className="max-h-80 space-y-0.5 overflow-y-auto">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-1 rounded-md px-2 py-1.5">
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-sm',
                row.hidden ? 'text-slate-400 line-through dark:text-slate-500' : 'text-slate-700 dark:text-slate-200',
              )}
            >
              {row.label}
              {row.detail ? (
                <span className="ml-1.5 font-mono text-xs text-slate-400 dark:text-slate-500">{row.detail}</span>
              ) : null}
            </span>
            {row.orderable !== false ? (
              <>
                <button type="button" className={iconBtn} aria-label={`${row.label} ↑`} disabled={row.key === firstKey} onClick={() => onMove(row.key, -1)}>
                  <ChevronUp size={14} />
                </button>
                <button type="button" className={iconBtn} aria-label={`${row.label} ↓`} disabled={row.key === lastKey} onClick={() => onMove(row.key, 1)}>
                  <ChevronDown size={14} />
                </button>
              </>
            ) : null}
            <button type="button" className={iconBtn} aria-label={row.label} onClick={() => onToggle(row.key)}>
              {row.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 border-t border-slate-100 pt-2 dark:border-slate-800">
        <button
          type="button"
          onClick={onReset}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/60 dark:hover:text-slate-100"
        >
          <RotateCcw size={13} />
          {resetLabel}
        </button>
      </div>
    </Popover>
  )
}
