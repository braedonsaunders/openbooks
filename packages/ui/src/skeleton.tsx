import * as React from 'react'
import { cn } from './utils'

/**
 * Skeleton placeholder with a left→right shimmer sweep. The shimmer lives
 * in `styles.css` as `.bhs-shimmer` so it works server-rendered.
 * Reduced-motion users get a static placeholder (no animation).
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'bhs-shimmer relative overflow-hidden rounded-md bg-slate-200/70 dark:bg-slate-700/50',
        className,
      )}
      {...props}
    />
  )
}
