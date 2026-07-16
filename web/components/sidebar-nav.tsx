'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Activity,
  AlertTriangle,
  Award,
  BellRing,
  BookOpen,
  Building2,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  CircleUser,
  ClipboardCheck,
  ClipboardList,
  Code2,
  Construction,
  Database,
  FileText,
  Folder,
  Download,
  Gauge,
  GraduationCap,
  HardHat,
  HeartPulse,
  History,
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
  Upload,
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
  activity: Activity,
  'heart-pulse': HeartPulse,
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
  download: Download,
  upload: Upload,
  history: History,
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
  'chevron-right': ChevronRight,
}

export type SidebarNavItem = {
  href: string
  label: string
  iconKey: keyof typeof ICONS | string
  /** When set, the item is active ONLY on an exact path match (no greedy
   * prefix). Used for hub/overview links that are a prefix of their siblings. */
  exact?: boolean
  /** Nested sub-menu this item belongs to. Contiguous items sharing a subgroup
   * render under one collapsible header in the desktop sidebar. */
  subgroup?: string
  /** When set, the subgroup header itself navigates here (a landing hub for
   * the section) in addition to expanding its children. */
  subgroupHref?: string
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
          {toBlocks(group.items).map((block, bi) =>
            block.kind === 'item' ? (
              <NavLink
                key={block.item.href}
                item={block.item}
                active={activeHref === block.item.href}
                collapsed={collapsed}
              />
            ) : (
              <SubgroupSection
                key={`sub-${block.label}-${bi}`}
                label={block.label}
                href={block.href}
                items={block.items}
                activeHref={activeHref}
                collapsed={collapsed}
              />
            ),
          )}
        </div>
      ))}
    </nav>
  )
}

// --- nested-menu helpers (shared with the top nav's flyout sub-menus) ------

export type NavBlock =
  | { kind: 'item'; item: SidebarNavItem }
  | { kind: 'subgroup'; label: string; href?: string; items: SidebarNavItem[] }

/** Fold a flat item list into blocks, coalescing runs that share a subgroup. */
export function toBlocks(items: SidebarNavItem[]): NavBlock[] {
  const blocks: NavBlock[] = []
  for (const item of items) {
    if (item.subgroup) {
      const last = blocks[blocks.length - 1]
      if (last && last.kind === 'subgroup' && last.label === item.subgroup) {
        last.items.push(item)
        if (!last.href) last.href = item.subgroupHref
      } else {
        blocks.push({
          kind: 'subgroup',
          label: item.subgroup,
          href: item.subgroupHref,
          items: [item],
        })
      }
    } else {
      blocks.push({ kind: 'item', item })
    }
  }
  return blocks
}

/** A single nav link. `nested` indents it under a subgroup header. */
function NavLink({
  item,
  active,
  collapsed,
  nested = false,
}: {
  item: SidebarNavItem
  active: boolean
  collapsed: boolean
  nested?: boolean
}) {
  const Icon = ICONS[item.iconKey] ?? Gauge
  return (
    <Link
      href={item.href as any}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
      data-walkthrough={`nav:${item.href}`}
      className={cn(
        'group relative flex items-center rounded-md py-1.5 text-sm',
        'transition-colors duration-150 ease-out',
        collapsed ? 'justify-center px-2' : nested ? 'gap-2.5 pr-2 pl-8' : 'gap-2.5 px-2',
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
}

/** Collapsible nested section. Auto-opens when a child (or its own landing
 *  page) is active. When `href` is set the label navigates to the section's
 *  landing hub while the chevron keeps toggling the children. In collapsed
 *  rail mode the header is dropped and children render as plain icon links. */
function SubgroupSection({
  label,
  href,
  items,
  activeHref,
  collapsed,
}: {
  label: string
  href?: string
  items: SidebarNavItem[]
  activeHref: string | null
  collapsed: boolean
}) {
  const selfActive = href != null && activeHref === href
  const hasActiveChild = items.some((i) => i.href === activeHref) || selfActive
  const [open, setOpen] = useState(hasActiveChild)
  // Navigating into a child from elsewhere should reveal the section.
  useEffect(() => {
    if (hasActiveChild) setOpen(true)
  }, [hasActiveChild])

  if (collapsed) {
    return (
      <>
        <div className="mx-2 my-1 border-t border-slate-100 dark:border-slate-800" aria-hidden />
        {items.map((item) => (
          <NavLink key={item.href} item={item} active={activeHref === item.href} collapsed />
        ))}
      </>
    )
  }

  const headerClass = cn(
    'group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm',
    'transition-colors duration-150 ease-out',
    selfActive
      ? 'bg-teal-50 text-teal-900 dark:bg-teal-950/50 dark:text-teal-100'
      : hasActiveChild && !open
        ? 'text-teal-800 dark:text-teal-200'
        : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100',
    'focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none',
  )
  const chevron = (
    <ChevronRight
      size={15}
      className={cn(
        'shrink-0 text-slate-400 transition-transform duration-150 dark:text-slate-500',
        open && 'rotate-90',
      )}
    />
  )

  return (
    <div>
      {href ? (
        // Linked header: the label navigates to the section's landing hub;
        // the chevron is a sibling click target so the section can be
        // toggled without navigating.
        <div className={cn(headerClass, 'p-0')}>
          <button
            type="button"
            aria-expanded={open}
            aria-label={label}
            onClick={() => setOpen((o) => !o)}
            className="grid shrink-0 place-items-center self-stretch rounded-l-md pl-2 hover:bg-slate-200/60 dark:hover:bg-slate-700/60"
          >
            {chevron}
          </button>
          <Link
            href={href as any}
            aria-current={selfActive ? 'page' : undefined}
            data-walkthrough={`nav:${href}`}
            onClick={() => setOpen(true)}
            className="flex-1 rounded-r-md py-1.5 pr-2"
          >
            {label}
          </Link>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={headerClass}>
          {chevron}
          <span>{label}</span>
        </button>
      )}
      {open ? (
        <div className="mt-0.5 space-y-0.5">
          {items.map((item) => (
            <NavLink key={item.href} item={item} active={activeHref === item.href} collapsed={false} nested />
          ))}
        </div>
      ) : null}
    </div>
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
