import type { ReactNode } from 'react'
import { cn } from '@openbooks/ui'

/**
 * Plain value treatment for a drawer in view mode.
 *
 * View mode is a presentation state, not a disabled edit form: rendering
 * values as text keeps the record easy to scan and prevents inactive controls
 * from competing with the drawer's actual actions.
 */
export function ReadOnlyValue({
  value,
  className,
}: {
  value: ReactNode
  className?: string
}) {
  const empty = value == null || value === ''

  return (
    <p
      className={cn(
        'min-h-5 text-sm text-slate-700 dark:text-slate-300',
        empty && 'text-slate-400 dark:text-slate-500',
        className,
      )}
    >
      {empty ? '—' : value}
    </p>
  )
}
