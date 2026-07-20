import type { ReactNode } from 'react'
import { cn } from '@openbooks/ui'

/**
 * The single in-app paper surface for every rendered report. Report pages keep
 * their purpose-built tables and drill-through behavior, but all of them share
 * this document header, width, border, background, spacing, and print styling.
 */
export function ReportPaper({
  company,
  title,
  periodPhrase,
  note,
  wide = false,
  children,
}: {
  company: string
  title: string
  periodPhrase?: string
  note?: string
  wide?: boolean
  children: ReactNode
}) {
  return (
    <article
      data-report-paper
      className={cn(
        'mx-auto w-full rounded-lg border border-slate-200 bg-white px-6 py-8 text-slate-900 shadow-sm print:border-0 print:px-0 print:py-0 print:shadow-none sm:px-10 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100',
        wide ? 'max-w-none' : 'max-w-5xl',
      )}
    >
      <header className="mb-6 space-y-0.5 text-center">
        <div className="text-base font-semibold">{company}</div>
        <h2 className="text-xl font-bold tracking-tight">{title}</h2>
        {periodPhrase ? <div className="text-sm text-slate-500 dark:text-slate-400">{periodPhrase}</div> : null}
        {note ? <div className="text-xs text-slate-400 italic dark:text-slate-500">{note}</div> : null}
      </header>
      {children}
    </article>
  )
}
