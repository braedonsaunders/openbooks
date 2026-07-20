import type {
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react'
import { cn } from '@openbooks/ui'

/**
 * Report-only table primitives. Unlike the application list table, these do
 * not add a card, shaded/sticky chrome, hover states, row dividers, or motion.
 * Their typography and rules intentionally match the financial statements.
 */
export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className={cn('w-full border-collapse text-sm tabular-nums', className)}
        {...props}
      />
    </div>
  )
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('[&_tr]:border-b [&_tr]:border-slate-300 dark:[&_tr]:border-slate-600', className)} {...props} />
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={className} {...props} />
}

export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'py-2 pr-4 text-left align-bottom text-xs font-semibold tracking-wide text-slate-500 uppercase last:pr-0 dark:text-slate-400',
        className,
      )}
      {...props}
    />
  )
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('py-1 pr-4 align-top last:pr-0', className)} {...props} />
}

export const reportSubtotalRowClass = 'border-t border-slate-300 dark:border-slate-600'
export const reportTotalRowClass =
  'border-t border-b-[3px] border-double border-slate-400 dark:border-slate-500'
