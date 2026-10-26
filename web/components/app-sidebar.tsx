'use client'

// The desktop sidebar: two layers. A compact rail lists the workspaces as
// icons; the panel beside it lists the pages of the workspace that owns the
// current page, or of one the reader is browsing. Collapsing slides the panel
// away and leaves the rail, whose icons then open their pages in a flyout. The
// choice is persisted in a cookie so the server can render the correct width
// on the next load (no width flash).

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Popover, cn, useHydrated } from '@openbooks/ui'
import { BrandHomeLink } from './brand-home-link'
import {
  NavIcon,
  NavLink,
  toBlocks,
  useActiveNav,
  useScrollActiveIntoView,
  type SidebarNavGroup,
  type SidebarNavItem,
} from './sidebar-nav'
import { useNavGroups } from './use-platform-nav'

const COOKIE = 'sidebar_collapsed'
const CLOSED_SECTIONS_KEY = 'openbooks.nav.closed-sections'
const PANEL_ID = 'app-sidebar-panel'

/** Workspaces anchored to the foot of the rail rather than the main list. */
const FOOT_GROUP_IDS = new Set(['settings'])

export function AppSidebar({
  groups,
  defaultCollapsed = false,
}: {
  groups: SidebarNavGroup[]
  defaultCollapsed?: boolean
}) {
  const t = useTranslations('shell.sidebar')
  const navGroups = useNavGroups(groups)
  const { location, activeHref, activeGroupId } = useActiveNav(navGroups)
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const panelRef = useRef<HTMLElement>(null)

  // Browsing another workspace lasts until the next navigation; every page
  // opens the panel on the workspace that owns it.
  const [browsing, setBrowsing] = useState<{ groupId: string; location: string } | null>(null)
  const browsedId = browsing?.location === location ? browsing.groupId : null
  const selected =
    navGroups.find((group) => group.id === browsedId) ??
    navGroups.find((group) => group.id === activeGroupId) ??
    navGroups[0]

  useScrollActiveIntoView(panelRef, `${selected?.id}|${activeHref}`, !collapsed)

  // Which way the reader moved along the rail, so the panel's pages arrive
  // from that side. Derived during render; null until the first switch, so
  // the initial paint does not animate.
  const [shown, setShown] = useState<{ id: string | undefined; direction: 'up' | 'down' | null }>(() => ({
    id: selected?.id,
    direction: null,
  }))
  if (shown.id !== selected?.id) {
    const from = navGroups.findIndex((group) => group.id === shown.id)
    const to = navGroups.findIndex((group) => group.id === selected?.id)
    setShown({ id: selected?.id, direction: from >= 0 && to < from ? 'up' : 'down' })
  }

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c
      try {
        document.cookie = `${COOKIE}=${next ? '1' : '0'};path=/;max-age=31536000;samesite=lax`
      } catch {
        /* cookies unavailable — stays in-memory */
      }
      return next
    })
  }, [])

  const rail = (group: SidebarNavGroup) => (
    <RailWorkspace
      key={group.id}
      group={group}
      activeHref={activeHref}
      active={group.id === activeGroupId}
      selected={!collapsed && group.id === selected?.id}
      flyout={collapsed}
      onSelect={() => setBrowsing({ groupId: group.id, location })}
    />
  )
  const footGroups = navGroups.filter((group) => FOOT_GROUP_IDS.has(group.id))

  return (
    <aside className="hidden shrink-0 lg:flex">
      <div className="flex w-[4.5rem] flex-col border-r border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
        <div className="flex h-14 shrink-0 items-center justify-center">
          <BrandHomeLink mark />
        </div>
        <nav aria-label={t('workspaces')} className="relative flex min-h-0 flex-1 flex-col px-1 pb-2">
          <RailSelectionChip groupId={collapsed ? null : (selected?.id ?? null)} />
          <div
            data-rail-scroll
            className="relative flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {navGroups.filter((group) => !FOOT_GROUP_IDS.has(group.id)).map(rail)}
          </div>
          <div className="relative mx-2 mt-1 flex flex-col gap-1 border-t border-slate-200 pt-2 dark:border-slate-800">
            {footGroups.map(rail)}
          </div>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-controls={PANEL_ID}
            aria-label={collapsed ? t('expand') : t('collapse')}
            title={collapsed ? t('expand') : t('collapse')}
            className="mx-auto mt-1 grid h-8 w-10 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </nav>
      </div>

      <div
        id={PANEL_ID}
        inert={collapsed}
        className={cn(
          'overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none',
          collapsed ? 'w-0' : 'w-56',
        )}
      >
        {selected ? (
          <div
            className={cn(
              'flex h-full w-56 flex-col border-r border-slate-200 bg-white transition-[opacity,translate] duration-200 ease-out motion-reduce:transition-none dark:border-slate-800 dark:bg-slate-900',
              collapsed ? '-translate-x-3 opacity-0' : 'translate-x-0 opacity-100',
            )}
          >
            <div
              key={selected.id}
              data-direction={shown.direction ?? undefined}
              className={cn('flex min-h-0 flex-1 flex-col', shown.direction && 'nav-panel-switch')}
            >
              <div className="flex h-14 shrink-0 items-center px-3">
                {selected.groupHref ? (
                  <Link
                    href={selected.groupHref as never}
                    aria-current={activeHref === selected.groupHref ? 'page' : undefined}
                    data-walkthrough={`nav:${selected.groupHref}`}
                    className={cn(
                      'group/home flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-[15px] font-semibold tracking-tight transition-colors',
                      'focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none',
                      activeHref === selected.groupHref
                        ? 'bg-teal-50 text-teal-900 dark:bg-teal-950/50 dark:text-teal-100'
                        : 'text-slate-900 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800',
                    )}
                  >
                    <span className="truncate">{selected.label}</span>
                    <ChevronRight
                      size={14}
                      className="shrink-0 text-slate-400 opacity-0 transition-opacity group-hover/home:opacity-100 dark:text-slate-500"
                    />
                  </Link>
                ) : (
                  <h2 className="min-w-0 flex-1 truncate px-2 text-[15px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                    {selected.label}
                  </h2>
                )}
              </div>
              <nav ref={panelRef} aria-label={selected.label} className="app-scroll flex-1 overflow-y-auto px-2 pb-3">
                <PanelItems groupId={selected.id} items={selected.items} activeHref={activeHref} />
              </nav>
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  )
}

/**
 * The raised chip marking the workspace shown in the panel. One element glides
 * between tiles rather than each tile toggling its own, so switching reads as
 * a single motion. Placement is written straight to the element (no render),
 * and the glide is enabled only after the first placement so the page never
 * opens with the chip flying in from the corner.
 */
function RailSelectionChip({ groupId }: { groupId: string | null }) {
  const chipRef = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    // The rail is this chip's parent; read it from the DOM, since a parent's
    // ref is not yet attached when a child's layout effect first runs.
    const chip = chipRef.current
    const rail = chip?.parentElement
    if (!rail || !chip) return
    const place = () => {
      const tile = groupId ? rail.querySelector<HTMLElement>(`[data-rail-chip="${CSS.escape(groupId)}"]`) : null
      if (!tile) {
        chip.style.opacity = '0'
        return
      }
      const railBox = rail.getBoundingClientRect()
      const tileBox = tile.getBoundingClientRect()
      chip.style.width = `${tileBox.width}px`
      chip.style.height = `${tileBox.height}px`
      chip.style.transform = `translate(${tileBox.left - railBox.left}px, ${tileBox.top - railBox.top}px)`
      chip.style.opacity = '1'
    }
    place()
    const frame = window.requestAnimationFrame(() => {
      chip.dataset.ready = 'true'
    })
    const list = rail.querySelector('[data-rail-scroll]')
    list?.addEventListener('scroll', place, { passive: true })
    const observer = new ResizeObserver(place)
    observer.observe(rail)
    return () => {
      window.cancelAnimationFrame(frame)
      list?.removeEventListener('scroll', place)
      observer.disconnect()
    }
  }, [groupId])
  return (
    <span
      ref={chipRef}
      aria-hidden
      className={cn(
        'pointer-events-none absolute top-0 left-0 rounded-lg bg-white opacity-0 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700',
        'data-[ready=true]:transition-[transform,opacity] data-[ready=true]:duration-300 data-[ready=true]:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none!',
      )}
    />
  )
}

/**
 * One workspace in the rail: icon tile over a short label. The workspace that
 * owns the current page is filled; the one shown in the panel is raised.
 * With the panel collapsed the tile opens the workspace's pages in a flyout.
 */
function RailWorkspace({
  group,
  activeHref,
  active,
  selected,
  flyout,
  onSelect,
}: {
  group: SidebarNavGroup
  activeHref: string | null
  active: boolean
  selected: boolean
  flyout: boolean
  onSelect: () => void
}) {
  const [open, setOpen] = useState(false)
  const raised = selected || (flyout && open)
  const tile = (
    <button
      type="button"
      title={group.label}
      aria-pressed={flyout ? undefined : selected}
      aria-expanded={flyout ? open : undefined}
      onClick={() => (flyout ? setOpen((value) => !value) : onSelect())}
      className="group/rail flex w-full flex-col items-center gap-1 rounded-lg pt-1 pb-1 focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none"
    >
      <span
        data-rail-chip={group.id}
        className={cn(
          'grid h-8 w-10 place-items-center rounded-lg transition-[background-color,color,box-shadow,scale] duration-200 group-active/rail:scale-95',
          active
            ? 'bg-teal-700 text-white shadow-sm shadow-teal-900/20 dark:bg-teal-500 dark:text-slate-950'
            : selected
              ? // The rail's gliding chip sits beneath this tile.
                'text-slate-900 dark:text-slate-100'
              : raised
                ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700'
                : 'text-slate-500 group-hover/rail:bg-slate-200/70 group-hover/rail:text-slate-800 dark:text-slate-400 dark:group-hover/rail:bg-slate-800 dark:group-hover/rail:text-slate-100',
        )}
      >
        <NavIcon iconKey={group.iconKey} size={17} />
      </span>
      <span
        className={cn(
          'w-full truncate px-0.5 text-center text-[10px] leading-3 tracking-tight transition-colors',
          active
            ? 'font-semibold text-teal-800 dark:text-teal-300'
            : raised
              ? 'font-semibold text-slate-900 dark:text-slate-100'
              : 'font-medium text-slate-500 group-hover/rail:text-slate-800 dark:text-slate-400 dark:group-hover/rail:text-slate-100',
        )}
      >
        {group.label}
      </span>
    </button>
  )
  if (!flyout) return tile
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="right"
      align="start"
      label={group.label}
      className="max-h-[min(40rem,calc(100vh-2rem))] w-60 overflow-y-auto"
      trigger={tile}
    >
      <div
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a')) setOpen(false)
        }}
      >
        {group.groupHref ? (
          <Link
            href={group.groupHref as never}
            aria-current={activeHref === group.groupHref ? 'page' : undefined}
            data-walkthrough={`nav:${group.groupHref}`}
            className="block px-4 pt-3 pb-1.5 text-sm font-semibold text-slate-900 transition-colors hover:text-teal-700 dark:text-slate-100 dark:hover:text-teal-300"
          >
            {group.label}
          </Link>
        ) : (
          <div className="px-4 pt-3 pb-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">{group.label}</div>
        )}
        <div className="px-2 pb-2">
          <PanelItems groupId={group.id} items={group.items} activeHref={activeHref} />
        </div>
      </div>
    </Popover>
  )
}

/**
 * A workspace's pages for the panel. The panel shows one workspace, so its
 * subgroups read as open section headings rather than nested accordions; each
 * can still be folded away, and a section holding the current page stays open.
 */
function PanelItems({
  groupId,
  items,
  activeHref,
}: {
  groupId: string
  items: SidebarNavItem[]
  activeHref: string | null
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())

  // Restore folded sections after hydration, during render, so the server and
  // the first client render agree.
  const hydrated = useHydrated()
  const [restored, setRestored] = useState(false)
  if (hydrated && !restored) {
    setRestored(true)
    setClosed(readClosedSections())
  }

  function toggle(key: string) {
    setClosed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(CLOSED_SECTIONS_KEY, JSON.stringify([...next]))
      } catch {
        // Storage is an enhancement; sections simply reopen on the next load.
      }
      return next
    })
  }

  return toBlocks(items).map((block, index) => {
    if (block.kind === 'item') {
      return (
        <div key={block.item.href} className={index === 0 ? undefined : 'mt-px'}>
          <NavLink item={block.item} active={activeHref === block.item.href} dense />
        </div>
      )
    }
    const key = `${groupId}/${block.label}`
    const holdsActive = block.href === activeHref || block.items.some((item) => item.href === activeHref)
    const open = holdsActive || !closed.has(key)
    const chevron = (
      <ChevronDown
        size={13}
        className={cn(
          'shrink-0 text-slate-400 transition-[transform,opacity] duration-150 dark:text-slate-500',
          open ? 'opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100' : '-rotate-90',
        )}
      />
    )
    const labelCls =
      'truncate text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400'
    return (
      <section key={`sub-${block.label}-${index}`} className={index === 0 ? 'pt-1' : 'pt-3'}>
        <div className="group/section flex items-center rounded-md">
          {block.href ? (
            <>
              <Link
                href={block.href as never}
                aria-current={activeHref === block.href ? 'page' : undefined}
                data-walkthrough={`nav:${block.href}`}
                className={cn(
                  labelCls,
                  'min-w-0 flex-1 rounded-md px-2 py-1 transition-colors hover:text-teal-700 focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none dark:hover:text-teal-300',
                  activeHref === block.href && 'text-teal-700 dark:text-teal-300',
                )}
              >
                {block.label}
              </Link>
              <button
                type="button"
                aria-expanded={open}
                aria-label={block.label}
                disabled={holdsActive}
                onClick={() => toggle(key)}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none disabled:pointer-events-none dark:hover:bg-slate-800"
              >
                {chevron}
              </button>
            </>
          ) : (
            <button
              type="button"
              aria-expanded={open}
              disabled={holdsActive}
              onClick={() => toggle(key)}
              className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-left hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-slate-800/60"
            >
              <span className={cn(labelCls, 'min-w-0 flex-1')}>{block.label}</span>
              {chevron}
            </button>
          )}
        </div>
        {open ? (
          <div className="mt-0.5 space-y-px">
            {block.items.map((item) => (
              <NavLink key={item.href} item={item} active={activeHref === item.href} dense />
            ))}
          </div>
        ) : null}
      </section>
    )
  })
}

function readClosedSections(): ReadonlySet<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(CLOSED_SECTIONS_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(saved) ? saved.filter((key): key is string => typeof key === 'string') : [])
  } catch {
    return new Set()
  }
}
