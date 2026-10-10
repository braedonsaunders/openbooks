'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  BookOpen,
  Box,
  Briefcase,
  Building2,
  Calendar,
  ClipboardList,
  Coins,
  Download,
  FileText,
  Gauge,
  Hash,
  History,
  Landmark,
  Layers,
  MapPin,
  Megaphone,
  Package,
  Percent,
  Receipt,
  Server,
  Shield,
  Sparkles,
  Tag,
  Timer,
  TrendingUp,
  Upload,
  Users,
  WalletCards,
  Workflow,
} from 'lucide-react'
import { cn } from '@openbooks/ui'
import { setupRail, setupRailItemLabel, type SetupRailFlags } from '../../../../lib/setup/rail'

// iconKey → lucide component. Keys come from the registry (SETUP_GROUPS / entities).
const ICONS: Record<string, ReactNode> = {
  'book-open': <BookOpen size={15} />,
  box: <Box size={15} />,
  briefcase: <Briefcase size={15} />,
  building: <Building2 size={15} />,
  receipt: <Receipt size={15} />,
  percent: <Percent size={15} />,
  layers: <Layers size={15} />,
  file: <FileText size={15} />,
  gauge: <Gauge size={15} />,
  tag: <Tag size={15} />,
  'map-pin': <MapPin size={15} />,
  package: <Package size={15} />,
  hash: <Hash size={15} />,
  calendar: <Calendar size={15} />,
  timer: <Timer size={15} />,
  shield: <Shield size={15} />,
  landmark: <Landmark size={15} />,
  'trending-up': <TrendingUp size={15} />,
  coins: <Coins size={15} />,
  users: <Users size={15} />,
  server: <Server size={15} />,
  download: <Download size={15} />,
  upload: <Upload size={15} />,
  history: <History size={15} />,
  payments: <WalletCards size={15} />,
  sparkles: <Sparkles size={15} />,
  // HR-15: home announcements entity icon.
  megaphone: <Megaphone size={15} />,
  'clipboard-list': <ClipboardList size={15} />,
  workflow: <Workflow size={15} />,
}

/** Index pages whose per-record builder pages live beneath them. */
const BUILDER_INDEXES = new Set(['/admin/setup/review-templates', '/admin/setup/hiring-pipelines'])

/** A query-addressed entry (one view of a shared page) is active when its own
 *  query values match; a plain entry matches the path alone. */
function railItemActive(href: string, pathname: string, search: URLSearchParams): boolean {
  const [path, query] = href.split('?')
  if (pathname !== path) return BUILDER_INDEXES.has(href) && pathname.startsWith(`${href}/`)
  if (!query) return true
  return [...new URLSearchParams(query)].every(([key, value]) => search.get(key) === value)
}

/**
 * Left rail for the Setup workspace — grouped list of tabs, one per registry
 * entity plus the special-cased Company tab, followed by the Import & Export
 * links (permission-gated). Client component (needs the active pathname).
 * The entries come from the shared rail model (lib/setup/rail.ts), which
 * global search also reads, so a Setup page is findable exactly when it is
 * on this rail.
 */
export function SetupNav(flags: SetupRailFlags) {
  const t = useTranslations('admin.setup')
  const tAll = useTranslations()
  const pathname = usePathname()
  const search = useSearchParams()
  const rail = setupRail(flags)
  const label = (key: string) => tAll(key as never)

  return (
    <nav className="min-w-0 w-full" aria-label={t('title')}>
      {/* Below sm the rail is a horizontal strip above the content: groups
          sit side by side and scroll sideways instead of squeezing the
          panel. sm and up restore the grouped vertical rail exactly. */}
      <div className="flex min-w-0 flex-row items-start gap-6 overflow-x-auto pb-1 sm:flex-col sm:items-stretch sm:gap-0 sm:space-y-5 sm:overflow-visible sm:pb-0">
        {rail.groups.map((group) => {
          return (
            <div key={group.key} className="shrink-0 space-y-1 sm:min-w-0 sm:w-full">
              <h3 className="hidden px-2 text-xs font-semibold tracking-wider text-slate-400 uppercase sm:block dark:text-slate-500">
                {label(group.labelKey)}
              </h3>
              <ul className="flex flex-row gap-1 sm:flex-col sm:gap-0 sm:space-y-0.5">
                {group.items.map((item) => {
                  // Builder index pages stay highlighted on their per-record pages.
                  const active = railItemActive(item.href, pathname, search)
                  return (
                    <li key={item.href} className="shrink-0 sm:min-w-0">
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors sm:w-full',
                          active
                            ? 'bg-teal-50 font-medium text-teal-700 dark:bg-teal-950/50 dark:text-teal-300'
                            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-100',
                        )}
                      >
                        <span className={cn('shrink-0', active ? 'text-teal-600 dark:text-teal-300' : 'text-slate-400')}>
                          {ICONS[item.iconKey] ?? <Tag size={15} />}
                        </span>
                        <span className="min-w-0 whitespace-nowrap sm:whitespace-normal sm:[overflow-wrap:anywhere]">{setupRailItemLabel(item, label)}</span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}

        {rail.data.items.length > 0 && (
          <div className="shrink-0 space-y-1 sm:min-w-0 sm:w-full">
            <h3 className="hidden px-2 text-xs font-semibold tracking-wider text-slate-400 uppercase sm:block dark:text-slate-500">
              {label(rail.data.labelKey)}
            </h3>
            <ul className="flex flex-row gap-1 sm:flex-col sm:gap-0 sm:space-y-0.5">
              {rail.data.items.map((item) => {
                const active = railItemActive(item.href, pathname, search)
                return (
                  <li key={item.href} className="shrink-0 sm:min-w-0">
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors sm:w-full',
                        active
                          ? 'bg-teal-50 font-medium text-teal-700 dark:bg-teal-950/50 dark:text-teal-300'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-100',
                      )}
                    >
                      <span className={cn('shrink-0', active ? 'text-teal-600 dark:text-teal-300' : 'text-slate-400')}>
                        {ICONS[item.iconKey] ?? <Tag size={15} />}
                      </span>
                      <span className="min-w-0 whitespace-nowrap sm:whitespace-normal sm:[overflow-wrap:anywhere]">{setupRailItemLabel(item, label)}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    </nav>
  )
}
