import Link from 'next/link'
import { cn } from '@openbooks/ui'

/**
 * URL-driven subtab strip for DetailPageLayout's `subtabs` slot. Server
 * component: each tab is a plain link that sets `?tab=<key>`; the page renders
 * the active tab's content from `searchParams`. No client JS — tabs are
 * shareable/bookmarkable and SSR-friendly.
 */
export function DetailSubtabs({
  tabs,
  active,
  basePath,
  extraParams,
}: {
  tabs: { key: string; label: string }[]
  active: string
  basePath: string
  /** Extra query params to preserve on each tab link. */
  extraParams?: Record<string, string>
}) {
  const qs = (key: string) => {
    const params = new URLSearchParams({ ...(extraParams ?? {}), tab: key })
    return `${basePath}?${params.toString()}`
  }
  return (
    <nav className="-mb-px flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
      {tabs.map((tab) => {
        const isActive = tab.key === active
        return (
          <Link
            key={tab.key}
            href={qs(tab.key) as any}
            className={cn(
              'border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'border-teal-500 text-teal-700 dark:text-teal-300'
                : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
