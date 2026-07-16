'use client'

// NetSuite-style top menu bar — the alternative to the left sidebar rail. Each
// SidebarNavGroup (the same `groups` prop the sidebar consumes from
// resolveNav) becomes a dropdown via the portal-based Popover (escapes the
// header's overflow-hidden). Active matching reuses findActiveNavHref so the
// two layouts always agree on "where am I".
//
// Items sharing a `subgroup` (e.g. Settings → Build) render as a second-level
// flyout sub-menu — the same toBlocks fold the sidebar uses for its
// collapsible sections, so both layouts always agree on nesting too.
//
// The bar is hidden below lg (the mobile drawer takes over there). Only one
// dropdown is open at a time; hover-to-open with a small close delay so the
// pointer can cross the gap between trigger and panel.

import { useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Popover, cn } from '@openbooks/ui'
import { NavIcon, toBlocks, type SidebarNavGroup, type SidebarNavItem } from './sidebar-nav'
import { findActiveNavHref } from './sidebar-nav-active'
import { useNavGroups } from './use-platform-nav'

export function TopNav({ groups }: { groups: SidebarNavGroup[] }) {
  const t = useTranslations('shell.topNav')
  const pathname = usePathname() ?? ''
  const navGroups = useNavGroups(groups)
  const activeHref = findActiveNavHref(pathname, navGroups)
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  function enterMenu(i: number) {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setOpenIdx(i)
  }

  function scheduleClose() {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpenIdx(null), 150)
  }

  return (
    <nav
      aria-label={t('ariaLabel')}
      // flex-1 min-w-0 so the bar yields space to the right-hand cluster
      // (assistant + account, both shrink-0); overflow-x-auto with a hidden
      // scrollbar means a bar too wide to fit SCROLLS instead of overflowing
      // its box and colliding with that cluster.
      className="hidden min-w-0 flex-1 items-center gap-0.5 overflow-x-auto lg:flex [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {navGroups.map((group, i) => {
        const open = openIdx === i
        const groupActive = group.items.some((item) => item.href === activeHref)
        return (
          <Popover
            key={group.label}
            open={open}
            onOpenChange={(o) => (o ? enterMenu(i) : setOpenIdx(null))}
            align="start"
            className="min-w-[15rem] py-1.5"
            trigger={
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-current={groupActive ? 'true' : undefined}
                onMouseEnter={() => enterMenu(i)}
                onMouseLeave={scheduleClose}
                className={cn(
                  'flex h-14 shrink-0 items-center gap-1 whitespace-nowrap px-2 text-sm font-medium transition-colors',
                  groupActive
                    ? 'text-teal-700 dark:text-teal-300'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100',
                )}
              >
                {group.label}
                <ChevronDown size={12} className="opacity-50" />
              </button>
            }
          >
            <div
              role="menu"
              onMouseEnter={() => enterMenu(i)}
              onMouseLeave={scheduleClose}
              onClick={() => setOpenIdx(null)}
            >
              {toBlocks(group.items).map((block, bi) =>
                block.kind === 'item' ? (
                  <MenuItemLink
                    key={block.item.href}
                    item={block.item}
                    active={activeHref === block.item.href}
                  />
                ) : (
                  <SubmenuRow
                    key={`sub-${block.label}-${bi}`}
                    label={block.label}
                    href={block.href}
                    items={block.items}
                    activeHref={activeHref}
                  />
                ),
              )}
            </div>
          </Popover>
        )
      })}
    </nav>
  )
}

/** One dropdown entry — used both at the top level and inside flyouts. */
function MenuItemLink({ item, active }: { item: SidebarNavItem; active: boolean }) {
  return (
    <Link
      href={item.href as never}
      aria-current={active ? 'page' : undefined}
      role="menuitem"
      data-walkthrough={`nav:${item.href}`}
      className={cn(
        'group flex items-center gap-2.5 px-3 py-1.5 text-sm transition-colors',
        active
          ? 'bg-teal-50 text-teal-900 dark:bg-teal-950/50 dark:text-teal-100'
          : 'text-slate-700 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-200 dark:hover:bg-slate-800/60 dark:hover:text-slate-100',
      )}
    >
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
    </Link>
  )
}

/**
 * Second-level flyout: a row that opens its children in a panel to the side.
 * Hover-to-open with the same 150ms close grace as the top-level menus. When
 * the subgroup has a landing hub (`href`) the row is a link — clicking
 * navigates there (bubbling to the group menu's onClick closes the dropdown);
 * otherwise clicking toggles the flyout (keyboard / touch). The flyout is
 * absolutely positioned inside the portal panel, so no overflow clipping —
 * it flips to the left edge when it would overrun the viewport.
 */
function SubmenuRow({
  label,
  href,
  items,
  activeHref,
}: {
  label: string
  href?: string
  items: SidebarNavItem[]
  activeHref: string | null
}) {
  const [open, setOpen] = useState(false)
  const [flip, setFlip] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)
  const selfActive = href != null && activeHref === href
  const childActive = items.some((i) => i.href === activeHref) || selfActive

  function openMenu() {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    const r = rowRef.current?.getBoundingClientRect()
    // 15rem panel + a little breathing room before the viewport edge.
    setFlip(r ? r.right + 248 > window.innerWidth : false)
    setOpen(true)
  }

  function scheduleClose() {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), 150)
  }

  return (
    <div
      ref={rowRef}
      className="relative"
      onMouseEnter={openMenu}
      onMouseLeave={scheduleClose}
    >
      {(() => {
        const rowClass = cn(
          'group flex w-full items-center gap-2.5 px-3 py-1.5 text-sm transition-colors',
          selfActive
            ? 'bg-teal-50 text-teal-900 dark:bg-teal-950/50 dark:text-teal-100'
            : childActive
              ? 'text-teal-800 dark:text-teal-200'
              : 'text-slate-700 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-200 dark:hover:bg-slate-800/60 dark:hover:text-slate-100',
        )
        const rowContent = (
          <>
            {/* spacer keeps the label column aligned with sibling item labels */}
            <span className="w-[15px] shrink-0" aria-hidden />
            <span className="flex-1 truncate text-left">{label}</span>
            <ChevronRight
              size={12}
              className={cn('shrink-0 opacity-50', flip && open && 'rotate-180')}
            />
          </>
        )
        return href ? (
          <Link
            href={href as never}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-current={selfActive ? 'page' : undefined}
            data-walkthrough={`nav:${href}`}
            className={rowClass}
          >
            {rowContent}
          </Link>
        ) : (
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={(e) => {
              // Keep the parent dropdown open — its menu div closes on click.
              e.stopPropagation()
              setOpen((o) => !o)
            }}
            className={rowClass}
          >
            {rowContent}
          </button>
        )
      })()}
      {open ? (
        <div
          role="menu"
          className={cn(
            'absolute top-0 z-10 min-w-[15rem] rounded-md border border-slate-200 bg-white py-1.5 shadow-xl dark:border-slate-800 dark:bg-slate-900',
            flip ? 'right-full -mr-1' : 'left-full -ml-1',
          )}
        >
          {items.map((item) => (
            <MenuItemLink key={item.href} item={item} active={activeHref === item.href} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
