import Link from 'next/link'
import { cn } from '@openbooks/ui'

/**
 * Pieces of the approvals hub shared by the page and the widget registry.
 *
 * Both are conditional composites — a chip that changes treatment when it is
 * the active filter, a tab that grows a count bubble — so they are components.
 * `when` omits a block; it does not choose between two.
 */

export function KindChips({
  chips,
  clearHref,
  clearLabel,
}: {
  chips: { kind: string; label: string; count: number; active: boolean; href: string }[]
  clearHref: string | null
  clearLabel: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <Link
          key={chip.kind}
          href={chip.href as never}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
            chip.active
              ? 'border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-300'
              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800/60',
          )}
        >
          {chip.label}
          <span
            className={cn(
              'tabular-nums',
              chip.active ? 'text-teal-600 dark:text-teal-400' : 'text-slate-400 dark:text-slate-500',
            )}
          >
            {chip.count}
          </span>
        </Link>
      ))}
      {clearHref ? (
        <Link
          href={clearHref as never}
          className="text-xs text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
        >
          {clearLabel}
        </Link>
      ) : null}
    </div>
  )
}

export function ApprovalTabs({
  tabs,
}: {
  tabs: { key: string; href: string; label: string; active: boolean; count: number | null }[]
}) {
  return (
    <nav className="flex items-center gap-1">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href as never}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            tab.active
              ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300'
              : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
          )}
        >
          {tab.label}
          {typeof tab.count === 'number' ? (
            <span
              className={cn(
                'rounded-full px-1.5 text-xs tabular-nums',
                tab.active
                  ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/60 dark:text-teal-300'
                  : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
              )}
            >
              {tab.count}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  )
}

/** The flow name on a submitted row — a nested span with its own treatment. */
export function ApprovalEngineCell({ name }: { name: string }) {
  return <span className="text-slate-900 dark:text-slate-100">{name}</span>
}

/** A submitted document's number: a link when the record is reachable. */
export function SubmittedDocumentCell({
  documentNumber,
  href,
}: {
  documentNumber: string
  href: string | null
}) {
  if (!href) return <>{documentNumber}</>
  return (
    <Link href={href as never} className="text-teal-700 hover:underline dark:text-teal-300">
      {documentNumber}
    </Link>
  )
}
