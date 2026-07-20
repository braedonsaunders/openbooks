'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
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
  Package,
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
  Target,
  Timer,
  TrendingUp,
  Truck,
  Upload,
  Users,
  Wallet,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { Popover, cn } from '@openbooks/ui'
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
  target: Target,
  package: Package,
  timer: Timer,
  truck: Truck,
  'trending-up': TrendingUp,
  users: Users,
  wallet: Wallet,
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
  /** Icon for the subgroup header (rendered like a regular item's icon). */
  subgroupIconKey?: string
  /** Tenant-selected shortcut in the four-item mobile tab bar. */
  mobile?: boolean
}

export type SidebarNavGroup = {
  /** Stable workspace id; labels may be translated or tenant-customized. */
  id: string
  label: string
  iconKey: string
  items: SidebarNavItem[]
}

const EXPANDED_STORAGE_KEY = 'openbooks.nav.expanded-workspaces'

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
export function SidebarNav({ groups, collapsed = false }: { groups: SidebarNavGroup[]; collapsed?: boolean }) {
  const pathname = usePathname() ?? ''
  const activeHref = findActiveNavHref(pathname, groups)
  const activeGroupId = groups.find((group) => groupContainsActiveHref(group, activeHref))?.id ?? null
  const navRef = useRef<HTMLElement>(null)
  const [openGroupIds, setOpenGroupIds] = useState<Set<string>>(
    () => new Set([groups[0]?.id, activeGroupId].filter((id): id is string => Boolean(id))),
  )
  const openGroupKey = useMemo(() => [...openGroupIds].sort().join('|'), [openGroupIds])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(EXPANDED_STORAGE_KEY)
      if (raw === null) return
      const saved = JSON.parse(raw) as unknown
      if (!Array.isArray(saved)) return
      const valid = saved.filter(
        (id): id is string => typeof id === 'string' && groups.some((group) => group.id === id),
      )
      setOpenGroupIds(new Set([...valid, activeGroupId].filter((id): id is string => Boolean(id))))
    } catch {
      // Corrupt or unavailable storage falls back to Home + the active workspace.
    }
  }, [activeGroupId, groups])

  useEffect(() => {
    if (!activeGroupId) return
    setOpenGroupIds((current) => {
      if (current.has(activeGroupId)) return current
      const next = new Set(current).add(activeGroupId)
      persistExpandedGroups(next)
      return next
    })
  }, [activeGroupId])

  useEffect(() => {
    if (collapsed) return
    const frame = window.requestAnimationFrame(() => {
      navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [collapsed, openGroupKey, pathname])

  function toggleGroup(id: string) {
    setOpenGroupIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      persistExpandedGroups(next)
      return next
    })
  }

  return (
    <nav ref={navRef} className={cn('app-scroll flex-1 overflow-y-auto px-2 py-3', collapsed && 'space-y-1')}>
      {collapsed
        ? groups.map((group) => (
            <CollapsedWorkspace
              key={group.id}
              group={group}
              activeHref={activeHref}
              active={group.id === activeGroupId}
            />
          ))
        : groups.map((group) => {
            const open = openGroupIds.has(group.id)
            const active = group.id === activeGroupId
            const panelId = `nav-workspace-${group.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
            return (
              <section key={group.id} className="mb-1">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => toggleGroup(group.id)}
                  className={cn(
                    'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-semibold tracking-wide transition-colors',
                    active
                      ? 'bg-teal-50/80 text-teal-800 dark:bg-teal-950/40 dark:text-teal-200'
                      : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100',
                    'focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none',
                  )}
                >
                  <NavIcon iconKey={group.iconKey} size={14} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left uppercase">{group.label}</span>
                  <ChevronRight
                    size={13}
                    className={cn('shrink-0 opacity-60 transition-transform duration-150', open && 'rotate-90')}
                  />
                </button>
                {open ? (
                  <div id={panelId} className="mt-0.5 space-y-0.5">
                    <WorkspaceItems items={group.items} activeHref={activeHref} />
                  </div>
                ) : null}
              </section>
            )
          })}
    </nav>
  )
}

function groupContainsActiveHref(group: SidebarNavGroup, activeHref: string | null) {
  return group.items.some((item) => item.href === activeHref || item.subgroupHref === activeHref)
}

function persistExpandedGroups(ids: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // Storage is an enhancement; navigation remains fully functional without it.
  }
}

function WorkspaceItems({ items, activeHref }: { items: SidebarNavItem[]; activeHref: string | null }) {
  return toBlocks(items).map((block, bi) =>
    block.kind === 'item' ? (
      <NavLink key={block.item.href} item={block.item} active={activeHref === block.item.href} />
    ) : (
      <SubgroupSection
        key={`sub-${block.label}-${bi}`}
        label={block.label}
        href={block.href}
        iconKey={block.iconKey}
        items={block.items}
        activeHref={activeHref}
      />
    ),
  )
}

function CollapsedWorkspace({
  group,
  activeHref,
  active,
}: {
  group: SidebarNavGroup
  activeHref: string | null
  active: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="right"
      align="start"
      className="max-h-[min(36rem,calc(100vh-2rem))] w-64 overflow-y-auto py-1.5"
      trigger={
        <button
          type="button"
          aria-label={group.label}
          aria-expanded={open}
          title={group.label}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            'relative grid h-9 w-full place-items-center rounded-md transition-colors',
            'before:absolute before:top-1/2 before:left-0 before:h-5 before:w-[2px] before:-translate-y-1/2 before:rounded-full',
            active
              ? 'bg-teal-50 text-teal-700 before:bg-teal-700 dark:bg-teal-950/50 dark:text-teal-300 dark:before:bg-teal-400'
              : 'text-slate-500 before:bg-transparent hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100',
            'focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none',
          )}
        >
          <NavIcon iconKey={group.iconKey} size={17} />
        </button>
      }
    >
      <div
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a')) setOpen(false)
        }}
      >
        <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400">
          {group.label}
        </div>
        <div className="py-1">
          <WorkspaceItems items={group.items} activeHref={activeHref} />
        </div>
      </div>
    </Popover>
  )
}

// --- nested-menu helpers (shared with the top nav's flyout sub-menus) ------

export type NavBlock =
  | { kind: 'item'; item: SidebarNavItem }
  | {
      kind: 'subgroup'
      label: string
      href?: string
      iconKey?: string
      items: SidebarNavItem[]
    }

/** Fold a flat item list into blocks, coalescing every item that shares a
 * subgroup. A workspace's explicit module order can interleave declarations
 * without fragmenting one logical section into repeated headings. */
export function toBlocks(items: SidebarNavItem[]): NavBlock[] {
  const blocks: NavBlock[] = []
  for (const item of items) {
    if (item.subgroup) {
      const existing = blocks.find(
        (block): block is Extract<NavBlock, { kind: 'subgroup' }> =>
          block.kind === 'subgroup' && block.label === item.subgroup,
      )
      if (existing) {
        existing.items.push(item)
        if (!existing.href) existing.href = item.subgroupHref
        if (!existing.iconKey) existing.iconKey = item.subgroupIconKey
      } else {
        blocks.push({
          kind: 'subgroup',
          label: item.subgroup,
          href: item.subgroupHref,
          iconKey: item.subgroupIconKey,
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
function NavLink({ item, active, nested = false }: { item: SidebarNavItem; active: boolean; nested?: boolean }) {
  const Icon = ICONS[item.iconKey] ?? Gauge
  const className = cn(
    'group relative flex items-center rounded-md py-1.5 text-sm',
    'transition-colors duration-150 ease-out',
    nested ? 'gap-2.5 pr-2 pl-8' : 'gap-2.5 px-2',
    'before:absolute before:top-1/2 before:left-0 before:h-5 before:w-[2px] before:-translate-y-1/2 before:rounded-full',
    'before:transition-all before:duration-150 before:ease-out',
    active
      ? 'bg-teal-50 text-teal-900 before:h-6 before:bg-teal-700 dark:bg-teal-950/50 dark:text-teal-100 dark:before:bg-teal-400'
      : 'text-slate-700 before:bg-transparent hover:bg-slate-100 hover:text-slate-900 hover:before:bg-slate-300 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100 dark:hover:before:bg-slate-600',
    'focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none',
  )
  const content = (
    <>
      <Icon
        size={15}
        className={cn(
          'shrink-0 transition-colors duration-150',
          active
            ? 'text-teal-700 dark:text-teal-300'
            : 'text-slate-500 group-hover:text-slate-700 dark:text-slate-400 dark:group-hover:text-slate-200',
        )}
      />
      <span>{item.label}</span>
    </>
  )
  return item.href.startsWith('https://') ? (
    <a href={item.href} data-walkthrough={`nav:${item.href}`} className={className}>
      {content}
    </a>
  ) : (
    <Link
      href={item.href as never}
      aria-current={active ? 'page' : undefined}
      data-walkthrough={`nav:${item.href}`}
      className={className}
    >
      {content}
    </Link>
  )
}

/** Collapsible nested section. Auto-opens when a child (or its own landing
 *  page) is active. When `href` is set the label navigates to the section's
 *  landing hub while the chevron keeps toggling the children. */
function SubgroupSection({
  label,
  href,
  iconKey,
  items,
  activeHref,
}: {
  label: string
  href?: string
  iconKey?: string
  items: SidebarNavItem[]
  activeHref: string | null
}) {
  const selfActive = href != null && activeHref === href
  const hasActiveChild = items.some((i) => i.href === activeHref) || selfActive
  const [open, setOpen] = useState(hasActiveChild)
  // Navigating into a child from elsewhere should reveal the section.
  useEffect(() => {
    if (hasActiveChild) setOpen(true)
  }, [hasActiveChild])

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
            className="flex flex-1 items-center gap-2.5 rounded-r-md py-1.5 pr-2"
          >
            {iconKey ? <NavIcon iconKey={iconKey} className="shrink-0 text-slate-500 dark:text-slate-400" /> : null}
            {label}
          </Link>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={headerClass}>
          {chevron}
          {iconKey ? <NavIcon iconKey={iconKey} className="shrink-0 text-slate-500 dark:text-slate-400" /> : null}
          <span>{label}</span>
        </button>
      )}
      {open ? (
        <div className="mt-0.5 space-y-0.5">
          {items.map((item) => (
            <NavLink key={item.href} item={item} active={activeHref === item.href} nested />
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
export function NavIcon({ iconKey, size = 15, className }: { iconKey: string; size?: number; className?: string }) {
  const Icon = ICONS[iconKey] ?? Gauge
  return <Icon size={size} className={className} />
}
