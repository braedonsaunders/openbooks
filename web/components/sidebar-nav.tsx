'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  AlertTriangle,
  Award,
  BellRing,
  BookOpen,
  Building2,
  CheckCircle2,
  CircleHelp,
  CircleUser,
  ClipboardCheck,
  ClipboardList,
  Code2,
  Construction,
  Database,
  FileText,
  Folder,
  Gauge,
  GraduationCap,
  HardHat,
  KeyRound,
  Layers,
  LayoutGrid,
  LibraryBig,
  Link2,
  ListChecks,
  Mail,
  MapPin,
  MessageSquare,
  NotebookPen,
  PanelLeft,
  Plus,
  QrCode,
  Radiation,
  Rss,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Tag,
  Timer,
  Users,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@openbooks/ui'
import { findActiveNavHref } from './sidebar-nav-active'

// Map string keys → icon components. RSCs can't serialise function references,
// so the parent server component passes us a key and we resolve client-side.
const ICONS: Record<string, LucideIcon> = {
  alert: AlertTriangle,
  award: Award,
  bell: BellRing,
  book: BookOpen,
  building: Building2,
  check: CheckCircle2,
  'circle-help': CircleHelp,
  'circle-user': CircleUser,
  'clipboard-check': ClipboardCheck,
  clipboard: ClipboardList,
  code: Code2,
  construction: Construction,
  database: Database,
  file: FileText,
  folder: Folder,
  gauge: Gauge,
  grad: GraduationCap,
  grid: LayoutGrid,
  'hard-hat': HardHat,
  layers: Layers,
  library: LibraryBig,
  link: Link2,
  'list-checks': ListChecks,
  mail: Mail,
  pin: MapPin,
  message: MessageSquare,
  journal: NotebookPen,
  key: KeyRound,
  'panel-left': PanelLeft,
  plus: Plus,
  'qr-code': QrCode,
  radiation: Radiation,
  rss: Rss,
  scroll: ScrollText,
  settings: Settings,
  shield: ShieldCheck,
  sparkles: Sparkles,
  star: Star,
  tag: Tag,
  timer: Timer,
  users: Users,
  workflow: Workflow,
  wrench: Wrench,
}

export type SidebarNavItem = {
  href: string
  label: string
  iconKey: keyof typeof ICONS | string
  /** When set, the item is active ONLY on an exact path match (no greedy
   * prefix). Used for hub/overview links that are a prefix of their siblings. */
  exact?: boolean
}

export type SidebarNavGroup = {
  label: string
  items: SidebarNavItem[]
}

/**
 * Pathname-aware sidebar nav.
 *
 *   • 2px left accent rail on active + hover
 *   • teal-tinted background + label color on active
 *   • smooth colour transitions on hover
 *   • keyboard focus ring tuned to the teal palette
 *
 * The "active" check is greedy: /equipment/123 highlights the /equipment
 * top-level nav item. Sub-routes therefore keep the parent illuminated.
 */
export function SidebarNav({
  groups,
  collapsed = false,
}: {
  groups: SidebarNavGroup[]
  collapsed?: boolean
}) {
  const pathname = usePathname() ?? ''
  const activeHref = findActiveNavHref(pathname, groups)
  return (
    <nav className={cn('app-scroll flex-1 overflow-y-auto py-3', collapsed ? 'px-2' : 'px-2')}>
      {groups.map((group) => (
        <div key={group.label} className="mb-3">
          {collapsed ? (
            <div
              className="mx-2 mb-1 border-t border-slate-100 dark:border-slate-800"
              aria-hidden
            />
          ) : (
            <div className="px-2 pb-1 text-[10px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
              {group.label}
            </div>
          )}
          {group.items.map((item) => {
            const active = activeHref === item.href
            const Icon = ICONS[item.iconKey] ?? Gauge
            return (
              <Link
                key={item.href}
                href={item.href as any}
                aria-current={active ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
                // Guided-tour anchor (lib/walkthroughs) — spotlights nav items.
                data-walkthrough={`nav:${item.href}`}
                className={cn(
                  'group relative flex items-center rounded-md py-1.5 text-sm',
                  'transition-colors duration-150 ease-out',
                  collapsed ? 'justify-center px-2' : 'gap-2.5 px-2',
                  'before:absolute before:top-1/2 before:left-0 before:h-5 before:w-[2px] before:-translate-y-1/2 before:rounded-full',
                  'before:transition-all before:duration-150 before:ease-out',
                  active
                    ? 'bg-teal-50 text-teal-900 before:h-6 before:bg-teal-700 dark:bg-teal-950/50 dark:text-teal-100 dark:before:bg-teal-400'
                    : 'text-slate-700 before:bg-transparent hover:bg-slate-100 hover:text-slate-900 hover:before:bg-slate-300 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100 dark:hover:before:bg-slate-600',
                  'focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none',
                )}
              >
                <Icon
                  size={15}
                  className={cn(
                    'shrink-0 transition-colors duration-150',
                    active
                      ? 'text-teal-700 dark:text-teal-300'
                      : 'text-slate-500 group-hover:text-slate-700 dark:text-slate-400 dark:group-hover:text-slate-200',
                  )}
                />
                {collapsed ? null : <span>{item.label}</span>}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

// --- Shared icon helpers (consumed by the /admin/navigation editor) -------

/** Stable, sorted list of icon keys offered by the nav editor's icon picker. */
export const ICON_KEYS = Object.keys(ICONS).sort()

/** Render a nav icon by its string key (falls back to a neutral gauge). */
export function NavIcon({
  iconKey,
  size = 15,
  className,
}: {
  iconKey: string
  size?: number
  className?: string
}) {
  const Icon = ICONS[iconKey] ?? Gauge
  return <Icon size={size} className={className} />
}
