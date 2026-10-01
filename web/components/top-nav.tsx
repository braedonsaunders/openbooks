'use client'

// source platform-style top menu bar — the alternative to the left sidebar rail. Each
// SidebarNavGroup (the same `groups` prop the sidebar consumes from
// resolveNav) becomes a dropdown via the portal-based Popover (escapes the
// header's overflow-hidden). Active matching reuses findActiveNavHref so the
// two layouts always agree on "where am I".
//
// Items sharing a `subgroup` render as labeled sections in a two-column panel,
// avoiding precision-hover cascades. The same toBlocks fold drives the
// sidebar's collapsible sections, so both layouts agree on organization.
//
// The bar is hidden below lg (the mobile drawer takes over there). Only one
// dropdown is open at a time; hover-to-open with a small close delay so the
// pointer can cross the gap between trigger and panel.

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Popover, cn } from '@openbooks/ui'
import { NavIcon, toBlocks, type SidebarNavGroup, type SidebarNavItem } from './sidebar-nav'
import { NavCountBadge } from './nav-count-badge'
import { findActiveNavHref } from './sidebar-nav-active'
import { useNavGroups } from './use-platform-nav'
import { visibleTopNavGroupCount } from '../lib/top-nav-overflow'
import { menuColumns } from '../lib/nav/menu-columns'

const MORE_MENU_INDEX = -1

function groupContainsActiveHref(group: SidebarNavGroup, activeHref: string | null) {
  return (
    group.groupHref === activeHref ||
    group.items.some((item) => item.href === activeHref || item.subgroupHref === activeHref)
  )
}

export function TopNav({ groups }: { groups: SidebarNavGroup[] }) {
  const t = useTranslations('shell.topNav')
  const pathname = usePathname() ?? ''
  const searchParams = useSearchParams()
  const navGroups = useNavGroups(groups)
  const query = searchParams.toString()
  const activeHref = findActiveNavHref(query ? `${pathname}?${query}` : pathname, navGroups)
  const moreLabel = t('more')
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [visibleCount, setVisibleCount] = useState(navGroups.length)
  const menuId = useId()
  const [focusEdge, setFocusEdge] = useState<'first' | 'last' | undefined>()
  const opener = useRef<HTMLElement | null>(null)
  const navRef = useRef<HTMLElement>(null)
  const measurementRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)

  useLayoutEffect(() => {
    const nav = navRef.current
    const measurement = measurementRef.current
    if (!nav || !measurement) return
    let active = true

    function measure() {
      if (!active) return
      const groupWidths = Array.from(
        measurement!.querySelectorAll<HTMLElement>('[data-top-nav-measure="group"]'),
        (element) => element.getBoundingClientRect().width,
      )
      const moreWidth =
        measurement!.querySelector<HTMLElement>('[data-top-nav-measure="more"]')?.getBoundingClientRect().width ?? 0
      const gap = Number.parseFloat(window.getComputedStyle(measurement!).columnGap) || 0
      const next = visibleTopNavGroupCount({
        availableWidth: nav!.clientWidth,
        groupWidths,
        moreWidth,
        gap,
      })
      setVisibleCount((current) => (current === next ? current : next))
    }

    measure()
    const frame = window.requestAnimationFrame(measure)
    const timer = window.setTimeout(measure, 0)
    const observer = new ResizeObserver(measure)
    observer.observe(nav)
    observer.observe(measurement)
    window.addEventListener('resize', measure)
    void document.fonts?.ready.then(measure)
    return () => {
      active = false
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      window.removeEventListener('resize', measure)
      observer.disconnect()
    }
  }, [navGroups, moreLabel])

  // Close the overflow menu when its entry scrolls out of the overflow range,
  // during render (same committed value, no extra render).
  if (
    openIdx !== null &&
    ((openIdx === MORE_MENU_INDEX && visibleCount === navGroups.length) || openIdx >= visibleCount)
  ) {
    setOpenIdx(null)
  }

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    },
    [],
  )

  function enterMenu(i: number) {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setOpenIdx(i)
  }

  function scheduleClose() {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => {
      if (!document.activeElement?.closest('[data-navigation-menu]')) setOpenIdx(null)
    }, 150)
  }

  function openFromControl(index: number, target: HTMLElement, edge: 'first' | 'last' = 'first') {
    opener.current = target
    setFocusEdge(edge)
    enterMenu(index)
  }

  function triggerKeyDown(event: KeyboardEvent<HTMLElement>, index: number) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    openFromControl(index, event.currentTarget, event.key === 'ArrowUp' ? 'last' : 'first')
  }

  function closeMenu(restoreFocus = false) {
    setOpenIdx(null)
    setFocusEdge(undefined)
    if (restoreFocus) opener.current?.focus()
  }

  const visibleGroups = navGroups.slice(0, visibleCount)
  const overflowGroups = navGroups.slice(visibleCount)
  const moreOpen = openIdx === MORE_MENU_INDEX
  const moreActive = overflowGroups.some((group) => groupContainsActiveHref(group, activeHref))

  return (
    <nav
      ref={navRef}
      aria-label={t('ariaLabel')}
      className="relative hidden min-w-0 flex-1 items-center gap-0.5 overflow-hidden lg:flex"
    >
      <div
        ref={measurementRef}
        aria-hidden
        className="pointer-events-none invisible absolute flex w-max items-center gap-0.5"
      >
        {navGroups.map((group, i) => (
          <span
            key={`${group.label}-${i}`}
            data-top-nav-measure="group"
            className="flex h-14 shrink-0 items-center gap-1 whitespace-nowrap px-2 text-sm font-medium"
          >
            {group.label}
            <ChevronDown size={12} className="opacity-50" />
          </span>
        ))}
        <span
          data-top-nav-measure="more"
          className="flex h-14 shrink-0 items-center gap-1 whitespace-nowrap px-2 text-sm font-medium"
        >
          {moreLabel}
          <ChevronDown size={12} className="opacity-50" />
        </span>
      </div>

      {visibleGroups.map((group, i) => {
        const open = openIdx === i
        const groupActive = groupContainsActiveHref(group, activeHref)
        const triggerCls = cn(
          'flex h-14 shrink-0 items-center gap-1 whitespace-nowrap px-2 text-sm font-medium transition-colors',
          groupActive
            ? 'text-teal-700 dark:text-teal-300'
            : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100',
        )
        return (
          <Popover
            key={group.label}
            open={open}
            onOpenChange={(o) => (o ? enterMenu(i) : setOpenIdx(null))}
            align="start"
            className="min-w-[15rem] py-1.5"
            trigger={
              group.groupHref ? (
                <div className={cn(triggerCls, 'gap-0 pr-1')} onMouseEnter={() => { setFocusEdge(undefined); enterMenu(i) }} onMouseLeave={scheduleClose}>
                  <Link
                    href={group.groupHref as never}
                    prefetch
                    aria-current={groupActive ? 'true' : undefined}
                    data-walkthrough={`nav:${group.groupHref}`}
                    onClick={() => closeMenu()}
                    onKeyDown={(event) => triggerKeyDown(event, i)}
                    className="flex h-full items-center focus-visible:outline-2 focus-visible:outline-teal-600"
                  >{group.label}</Link>
                  <button
                    type="button"
                    aria-label={t('openMenu', { name: group.label })}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    aria-controls={open ? `${menuId}-${i}` : undefined}
                    onKeyDown={(event) => triggerKeyDown(event, i)}
                    onClick={(event) => openFromControl(i, event.currentTarget)}
                    className="ml-1 flex h-8 w-5 items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-teal-600"
                  ><ChevronDown size={12} className="opacity-50" /></button>
                </div>
              ) : (
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={open}
                  aria-current={groupActive ? 'true' : undefined}
                  onMouseEnter={() => enterMenu(i)}
                  onMouseLeave={scheduleClose}
                  aria-controls={open ? `${menuId}-${i}` : undefined}
                  onKeyDown={(event) => triggerKeyDown(event, i)}
                  onClick={(event) => openFromControl(i, event.currentTarget)}
                  className={triggerCls}
                >
                  {group.label}
                  <ChevronDown size={12} className="opacity-50" />
                </button>
              )
            }
          >
            <GroupMenu
              id={`${menuId}-${i}`}
              label={group.label}
              focusEdge={focusEdge}
              onClose={closeMenu}
              items={group.items}
              activeHref={activeHref}
              onEnter={() => enterMenu(i)}
              onLeave={scheduleClose}
              onSelect={() => closeMenu()}
            />
          </Popover>
        )
      })}

      {overflowGroups.length > 0 ? (
        <Popover
          open={moreOpen}
          onOpenChange={(open) => (open ? enterMenu(MORE_MENU_INDEX) : setOpenIdx(null))}
          align="start"
          className="min-w-[15rem] py-1.5"
          trigger={
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-current={moreActive ? 'true' : undefined}
              onMouseEnter={() => enterMenu(MORE_MENU_INDEX)}
              onMouseLeave={scheduleClose}
              aria-controls={moreOpen ? `${menuId}-more` : undefined}
              onKeyDown={(event) => triggerKeyDown(event, MORE_MENU_INDEX)}
              onClick={(event) => openFromControl(MORE_MENU_INDEX, event.currentTarget)}
              className={cn(
                'flex h-14 shrink-0 items-center gap-1 whitespace-nowrap px-2 text-sm font-medium transition-colors',
                moreActive
                  ? 'text-teal-700 dark:text-teal-300'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100',
              )}
            >
              {moreLabel}
              <ChevronDown size={12} className="opacity-50" />
            </button>
          }
        >
          <NavigationMenu
            id={`${menuId}-more`}
            label={moreLabel}
            focusEdge={focusEdge}
            onClose={closeMenu}
            onMouseEnter={() => enterMenu(MORE_MENU_INDEX)}
            onMouseLeave={scheduleClose}
            onClick={() => closeMenu()}
          >
            {overflowGroups.map((group, i) => (
              <OverflowGroupRow key={`${group.label}-${visibleCount + i}`} group={group} activeHref={activeHref} />
            ))}
          </NavigationMenu>
        </Popover>
      ) : null}
    </nav>
  )
}

/** Keep native link activation while providing the menu keyboard contract. */
function NavigationMenu({ id, label, focusEdge, onClose, children, ...props }: {
  id?: string
  label?: string
  focusEdge?: 'first' | 'last'
  onClose?: (restoreFocus?: boolean) => void
  children: ReactNode
  className?: string
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  onClick?: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  function entries() {
    return Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
      .filter((item) => item.closest('[data-navigation-menu]') === root.current)
  }
  useEffect(() => {
    const items = entries()
    items.forEach((item) => { item.tabIndex = -1 })
    if (!focusEdge) return
    ;(focusEdge === 'last' ? items.at(-1) : items[0])?.focus()
  }, [focusEdge])
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose?.(true); return }
    if (event.key === 'Tab') { onClose?.(true); return }
    const items = entries()
    const index = items.indexOf(document.activeElement as HTMLElement)
    let next: number
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    else if (event.key === 'ArrowDown') next = (index + 1) % items.length
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
    else return
    event.preventDefault()
    event.stopPropagation()
    items[next]?.focus()
  }
  return <div ref={root} id={id} role="menu" aria-label={label} data-navigation-menu onKeyDown={keyDown} {...props}>{children}</div>
}

function GroupMenu({
  id, label, focusEdge, onClose,
  items,
  activeHref,
  onEnter,
  onLeave,
  onSelect,
}: {
  id?: string
  label?: string
  focusEdge?: 'first' | 'last'
  onClose?: (restoreFocus?: boolean) => void
  items: SidebarNavItem[]
  activeHref: string | null
  onEnter?: () => void
  onLeave?: () => void
  onSelect?: () => void
}) {
  const blocks = toBlocks(items)
  const sectioned = blocks.some((block) => block.kind === 'subgroup')
  const columns = sectioned ? menuColumns(blocks, (block) => block.kind === 'subgroup' ? block.items.length + 1.5 : 1) : [blocks]
  return (
    <NavigationMenu
      id={id} label={label} focusEdge={focusEdge} onClose={onClose}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onSelect}
      className={cn('max-h-[min(36rem,calc(100dvh-5rem))] overflow-y-auto', sectioned && 'w-[32rem] max-w-[calc(100vw-2rem)] p-1')}
    >
      <div className={cn(sectioned && columns.length > 1 && 'grid grid-cols-2 items-start gap-x-2')}>
      {columns.map((column, ci) => <div key={ci} data-nav-column className="min-w-0 space-y-1">
      {column.map((block, bi) =>
        block.kind === 'item' ? (
          <MenuItemLink key={block.item.href} item={block.item} active={activeHref === block.item.href} />
        ) : (
          <MenuSection
            key={`sub-${block.label}-${bi}`}
            label={block.label}
            href={block.href}
            iconKey={block.iconKey}
            items={block.items}
            activeHref={activeHref}
          />
        ),
      )}
      </div>)}
      </div>
    </NavigationMenu>
  )
}

function OverflowGroupRow({ group, activeHref }: { group: SidebarNavGroup; activeHref: string | null }) {
  const [open, setOpen] = useState(false)
  const [flip, setFlip] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)
  const active = groupContainsActiveHref(group, activeHref)
  const [focusEdge, setFocusEdge] = useState<'first' | undefined>()
  function openByKeyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'ArrowRight') return
    event.preventDefault(); event.stopPropagation(); setFocusEdge('first'); openMenu()
  }

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    },
    [],
  )

  function openMenu() {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    const rect = rowRef.current?.getBoundingClientRect()
    const panelWidth = group.items.some((item) => item.subgroup) ? 528 : 248
    setFlip(rect ? rect.right + panelWidth > window.innerWidth : false)
    setOpen(true)
  }

  function scheduleClose() {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), 150)
  }

  const rowCls = cn(
    'flex w-full items-center gap-2.5 px-3 py-1.5 text-sm transition-colors',
    active
      ? 'text-teal-800 dark:text-teal-200'
      : 'text-slate-700 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-200 dark:hover:bg-slate-800/60 dark:hover:text-slate-100',
  )
  const rowContent = (
    <>
      <NavIcon iconKey={group.iconKey} size={14} className="shrink-0 text-slate-400 dark:text-slate-500" />
      <span className="flex-1 truncate text-left">{group.label}</span>
      <ChevronRight size={12} className={cn('shrink-0 opacity-50', flip && open && 'rotate-180')} />
    </>
  )

  return (
    <div ref={rowRef} className="relative" onMouseEnter={openMenu} onMouseLeave={scheduleClose}>
      {group.groupHref ? (
        // Workspace with a module home: the row NAVIGATES on click (the parent
        // More-menu's onClick closes it); hover still opens the child flyout.
        <Link
          href={group.groupHref as never}
          prefetch
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open}
          data-walkthrough={`nav:${group.groupHref}`}
          onKeyDown={openByKeyboard}
          className={rowCls}
        >
          {rowContent}
        </Link>
      ) : (
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open}
          onKeyDown={openByKeyboard}
          onClick={(event) => {
            event.stopPropagation()
            setFocusEdge('first')
            setOpen((current) => !current)
          }}
          className={rowCls}
        >
          {rowContent}
        </button>
      )}
      {open ? (
        <div
          className={cn(
            'absolute top-0 z-10 min-w-[15rem] rounded-md border border-slate-200 bg-white py-1.5 shadow-xl dark:border-slate-800 dark:bg-slate-900',
            flip ? 'right-full -mr-1' : 'left-full -ml-1',
          )}
        >
          <GroupMenu label={group.label} items={group.items} activeHref={activeHref} focusEdge={focusEdge} onClose={(restore) => { setOpen(false); if (restore) rowRef.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus() }} />
        </div>
      ) : null}
    </div>
  )
}

/** One dropdown entry — used both at the top level and inside flyouts. */
function MenuItemLink({ item, active }: { item: SidebarNavItem; active: boolean }) {
  const className = cn(
    'group flex items-center gap-2.5 px-3 py-1.5 text-sm transition-colors',
    active
      ? 'bg-teal-50 text-teal-900 dark:bg-teal-950/50 dark:text-teal-100'
      : 'text-slate-700 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-200 dark:hover:bg-slate-800/60 dark:hover:text-slate-100',
  )
  const content = (
    <>
      <NavIcon
        iconKey={item.iconKey}
        size={15}
        className={cn(
          'shrink-0 transition-colors',
          active
            ? 'text-teal-700 dark:text-teal-300'
            : 'text-slate-500 group-hover:text-slate-700 dark:text-slate-400 dark:group-hover:text-slate-200',
        )}
      />
      <span className="truncate">{item.label}</span>
      {item.badgeCountHref ? <NavCountBadge source={item.badgeCountHref} /> : null}
    </>
  )
  return item.href.startsWith('https://') ? (
    <a href={item.href} role="menuitem" data-walkthrough={`nav:${item.href}`} className={className}>
      {content}
    </a>
  ) : (
    <Link
      href={item.href as never}
      prefetch
      aria-current={active ? 'page' : undefined}
      role="menuitem"
      data-walkthrough={`nav:${item.href}`}
      className={className}
    >
      {content}
    </Link>
  )
}

/** A labeled section inside a workspace panel. Sections replace cascading
 * flyouts so the full workspace can be scanned without precision hovering. */
function MenuSection({
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
  return (
    <div role="group" aria-label={label} className="min-w-0 rounded-md py-1">
      {href ? (
        <Link
          href={href as never}
          prefetch
          role="menuitem"
          aria-current={selfActive ? 'page' : undefined}
          data-walkthrough={`nav:${href}`}
          className={cn(
            'flex items-center gap-1.5 px-3 pb-1.5 text-[11px] font-semibold tracking-wide uppercase transition-colors',
            selfActive
              ? 'text-teal-700 dark:text-teal-300'
              : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100',
          )}
        >
          {iconKey ? <NavIcon iconKey={iconKey} size={13} /> : null}
          {label}
        </Link>
      ) : (
        <div className="px-3 pb-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          {label}
        </div>
      )}
      {items.map((item) => (
        <MenuItemLink key={item.href} item={item} active={activeHref === item.href} />
      ))}
    </div>
  )
}
