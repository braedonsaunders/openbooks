import type { ReactNode } from 'react'

/**
 * Wraps an on-screen financial statement so it reads like the printed PDF: a
 * centred 3-line header (company / statement title / period) on a white "sheet
 * of paper" card, so the in-app report matches the formal export.
 */
export function StatementPaper({
  company,
  title,
  periodPhrase,
  note,
  children,
}: {
  company: string
  title: string
  periodPhrase: string
  note?: string
  children: ReactNode
}) {
  return (
    <div className="mx-auto max-w-5xl rounded-lg border border-slate-200 bg-white px-6 py-8 shadow-sm sm:px-10 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-6 space-y-0.5 text-center">
        <div className="text-base font-semibold text-slate-900 dark:text-slate-100">{company}</div>
        <div className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{title}</div>
        <div className="text-sm text-slate-500 dark:text-slate-400">{periodPhrase}</div>
        {note ? <div className="text-xs text-slate-400 italic dark:text-slate-500">{note}</div> : null}
      </div>
      {children}
    </div>
  )
}
