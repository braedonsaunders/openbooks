import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { cn } from '@openbooks/ui'
import { NavIcon } from '../sidebar-nav'

/**
 * Module-home kit — the shared visual language of the workspace landing
 * cockpits (Banking, Customers, Purchasing, …). A module home is the page a
 * nav group header opens: vitals row (cockpit StatTiles), a hero surface, and
 * the LiveDirectory — the rest of the workspace's pages rendered as
 * data-annotated links, so the directory doubles as the module's work queue.
 * Server-component friendly: no state, plain links.
 */

export type ModuleHomeTab = { href: string; label: string; active?: boolean }

/** Route-tab pill strip for the page header — the /ap "Overview | Bills"
 * idiom generalized. Tabs are ROUTES, not client state, so the promoted
 * cockpits keep their own pages and the org's nav customization decides which
 * tabs exist. */
export function ModuleHomeTabs({ tabs }: { tabs: ModuleHomeTab[] }) {
  if (tabs.length < 2) return null
  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href as never}
          aria-current={tab.active ? 'page' : undefined}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors',
            tab.active
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
              : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  )
}

/** Inline history sparkline — pure server-rendered SVG (no chart runtime), so
 * a roster can afford one per row. Stroke inherits `currentColor`. */
export function Sparkline({
  points,
  width = 96,
  height = 24,
  className,
}: {
  points: number[]
  width?: number
  height?: number
  className?: string
}) {
  if (points.length < 2) return null
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const step = width / (points.length - 1)
  const pad = 2
  const coords = points.map(
    (value, i) =>
      `${(i * step).toFixed(1)},${(pad + (1 - (value - min) / span) * (height - pad * 2)).toFixed(1)}`,
  )
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden
      className={cn('shrink-0', className)}
    >
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export type DirectoryTone = 'neutral' | 'positive' | 'warning' | 'negative'

export type DirectoryBadge = {
  /** Compact live figure shown in the chip, e.g. "23" or "2 open". */
  value: string
  /** One-line secondary text under the label, e.g. "unmatched lines". */
  hint?: string
  tone?: DirectoryTone
}

export type DirectoryItem = {
  href: string
  label: string
  iconKey: string
  /** Live state pulled by the module-home loader. Omitted → plain link (org
   * custom links and pages with nothing to report render without a chip). */
  badge?: DirectoryBadge
}

const CHIP_TONE: Record<DirectoryTone, string> = {
  neutral: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  positive: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  negative: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
}

const ICON_TONE: Record<DirectoryTone, string> = {
  neutral: 'bg-teal-50 text-teal-700 ring-teal-100 dark:bg-teal-950/50 dark:text-teal-300 dark:ring-teal-900/50',
  positive:
    'bg-emerald-50 text-emerald-700 ring-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900/50',
  warning:
    'bg-amber-50 text-amber-700 ring-amber-100 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-900/50',
  negative: 'bg-red-50 text-red-700 ring-red-100 dark:bg-red-950/50 dark:text-red-300 dark:ring-red-900/50',
}

/**
 * The workspace's pages as a live work queue. Items come from the RESOLVED
 * nav group (permission-filtered, org-customized — hidden items never reach
 * here), annotated with what needs doing at each destination.
 */
export function LiveDirectory({ items, className }: { items: DirectoryItem[]; className?: string }) {
  if (items.length === 0) return null
  return (
    <ul className={cn('space-y-1.5', className)}>
      {items.map((item) => {
        const tone = item.badge?.tone ?? 'neutral'
        return (
          <li key={item.href}>
            <Link
              href={item.href as never}
              className="group flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 transition-colors hover:border-teal-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-teal-700"
            >
              <span
                className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg ring-1', ICON_TONE[tone])}
              >
                <NavIcon iconKey={item.iconKey} size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {item.label}
                </span>
                {item.badge?.hint ? (
                  <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{item.badge.hint}</span>
                ) : null}
              </span>
              {item.badge ? (
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums',
                    CHIP_TONE[tone],
                  )}
                >
                  {item.badge.value}
                </span>
              ) : null}
              <ArrowUpRight
                size={14}
                aria-hidden
                className="shrink-0 text-slate-300 opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100 group-hover:text-teal-600 dark:text-slate-600 dark:group-hover:text-teal-300"
              />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
