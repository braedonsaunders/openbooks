import Link from 'next/link'
import { ArrowRight, FileText, Sparkles } from 'lucide-react'
import { Button } from '@openbooks/ui'

/**
 * Pieces of the continuous-close screen that both render paths share.
 *
 * They live here rather than inside `page.tsx` for the reason SortTh taught:
 * two implementations of the same visual element drift, and a conformance
 * harness that compares one against the other would then be measuring the
 * drift instead of the conversion. One implementation, two callers.
 */

/** The findings/reports tab strip. */
export function TabNav({
  ariaLabel,
  tabs,
}: {
  ariaLabel: string
  tabs: { key: string; href: string; label: string; active: boolean }[]
}) {
  return (
    <nav className="-mb-2 flex gap-1 border-b border-slate-200 dark:border-slate-800" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href as never}
          role="tab"
          aria-selected={tab.active}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${tab.active
            ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
            : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200'}`}
        >{tab.label}</Link>
      ))}
    </nav>
  )
}

export function Metric({ label, value, locale, tone }: { label: string; value: number; locale: string; tone?: string }) {
  return <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950"><div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</div><div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone ?? ''}`}>{value.toLocaleString(locale)}</div></div>
}

/** Header strip of the narrative-reports card. */
export function ReportsCardHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
      <FileText size={16} className="text-violet-600 dark:text-violet-400" />
      <div><h2 className="text-sm font-semibold">{title}</h2><p className="text-xs text-slate-500">{description}</p></div>
    </div>
  )
}

export function NarrativeEntry({ narrative, href, labels }: { narrative: Record<string, unknown>; href: string; labels: { agent: string; fallbackTitle: string; generated: string; open: string } }) {
  const title = typeof narrative.title === 'string' ? narrative.title : labels.fallbackTitle
  const executiveSummary = typeof narrative.executiveSummary === 'string' ? narrative.executiveSummary : ''
  return (
    <section className="py-3">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"><Sparkles size={16} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500"><span className="font-medium text-violet-700 dark:text-violet-300">{labels.agent}</span><span>{labels.generated}</span></div>
          <h2 className="truncate text-sm font-semibold text-slate-950 dark:text-slate-50">{title}</h2>
          {executiveSummary ? <p className="mt-0.5 line-clamp-1 text-xs text-slate-600 dark:text-slate-400">{executiveSummary}</p> : null}
        </div>
        <Button variant="outline" size="sm" asChild><Link href={href as never}>{labels.open}<ArrowRight size={13} /></Link></Button>
      </div>
    </section>
  )
}

/** A finding's title over its one-line summary. */
export function FindingCell({ title, href, summary }: { title: string; href: string; summary: string }) {
  return (
    <>
      <Link href={href as never} className="font-medium text-slate-900 hover:text-teal-700 hover:underline dark:text-slate-100 dark:hover:text-teal-300">{title}</Link>
      <p className="mt-0.5 max-w-xl truncate text-xs text-slate-500">{summary}</p>
    </>
  )
}
