'use client'

import * as React from 'react'
import { motion, useReducedMotion, type HTMLMotionProps } from 'framer-motion'
import { cn } from './utils'

// ---------------- Shared context for row staggering ----------------
//
// `TableBody` resets a counter per render; each `TableRow` reads its index
// from the running counter so it can stagger its entrance animation.
// The counter only matters for the first N rows — after that the per-row
// delay clamps so rows in long tables don't pause forever.

type RowIndexContextValue = {
  next: () => number
}

const RowIndexContext = React.createContext<RowIndexContextValue | null>(null)

// ---------------- Table primitives ----------------

export const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="w-full overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  ),
)
Table.displayName = 'Table'

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn(
      'sticky top-0 z-10 bg-slate-50/95 shadow-[inset_0_-1px_0_rgb(226_232_240)] backdrop-blur-sm dark:bg-slate-900/80 dark:shadow-[inset_0_-1px_0_rgb(30_41_59)] [&_tr]:border-b [&_tr]:border-slate-200 dark:[&_tr]:border-slate-800',
      className,
    )}
    {...props}
  />
))
TableHeader.displayName = 'TableHeader'

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, children, ...props }, ref) => {
  // Hand out monotonically increasing indices to descendant rows.
  const counterRef = React.useRef(0)
  // Reset between renders so each fresh render starts the stagger from 0.
  counterRef.current = 0
  const value = React.useMemo<RowIndexContextValue>(
    () => ({
      next: () => {
        const i = counterRef.current
        counterRef.current += 1
        return i
      },
    }),
    [],
  )
  return (
    <RowIndexContext.Provider value={value}>
      <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props}>
        {children}
      </tbody>
    </RowIndexContext.Provider>
  )
})
TableBody.displayName = 'TableBody'

export type TableRowProps = HTMLMotionProps<'tr'> & {
  /** Disable the entrance animation for this row (e.g. for static rows). */
  noAnimate?: boolean
}

export const TableRow = React.forwardRef<HTMLTableRowElement, TableRowProps>(
  ({ className, noAnimate, ...props }, ref) => {
    const ctx = React.useContext(RowIndexContext)
    const reduce = useReducedMotion()
    // Capture the index once on mount via useState's lazy initializer so it
    // doesn't shift when the parent re-renders.
    const [index] = React.useState(() => (ctx ? ctx.next() : 0))
    // Clamp the stagger so the last visible row appears within ~0.25s even
    // for very long tables. After 12 rows everything animates simultaneously.
    const delay = Math.min(index, 12) * 0.02
    const skip = noAnimate || reduce || !ctx
    return (
      <motion.tr
        ref={ref}
        initial={skip ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, delay, ease: [0.22, 0.61, 0.36, 1] }}
        className={cn(
          'border-b border-slate-100 transition-colors duration-150 hover:bg-slate-50/80 data-[state=selected]:bg-slate-100 dark:border-slate-800 dark:hover:bg-slate-800/60 dark:data-[state=selected]:bg-slate-800',
          className,
        )}
        {...props}
      />
    )
  },
)
TableRow.displayName = 'TableRow'

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      'h-10 px-3 text-left align-middle text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400',
      className,
    )}
    {...props}
  />
))
TableHead.displayName = 'TableHead'

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td ref={ref} className={cn('px-3 py-3 align-middle', className)} {...props} />
))
TableCell.displayName = 'TableCell'
