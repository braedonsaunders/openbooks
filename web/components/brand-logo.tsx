import { cn } from '@openbooks/ui'

/**
 * openbooks wordmark. An open ledger glyph (two facing pages) + the name.
 * Sized for the sidebar header; `compact` renders the glyph alone.
 */
export function Logo({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
        className="shrink-0 text-teal-700 dark:text-teal-400"
      >
        <path
          d="M12 5.5C10 3.9 6.9 3.4 3.5 3.8v14.4c3.4-.4 6.5.1 8.5 1.7 2-1.6 5.1-2.1 8.5-1.7V3.8c-3.4-.4-6.5.1-8.5 1.7Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path d="M12 5.5v14.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M6.4 8.2c1.4-.1 2.7.1 3.8.6M6.4 11.2c1.4-.1 2.7.1 3.8.6M13.8 8.8c1.1-.5 2.4-.7 3.8-.6M13.8 11.8c1.1-.5 2.4-.7 3.8-.6"
          stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" className="opacity-60" />
      </svg>
      {compact ? null : (
        <span className="text-[17px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          open<span className="text-teal-700 dark:text-teal-400">books</span>
        </span>
      )}
    </span>
  )
}
