'use client'

// NetSuite-style top menu bar — the alternative to the left sidebar rail. Each
// SidebarNavGroup (the same `groups` prop the sidebar consumes from
// resolveNav) becomes a dropdown via the portal-based Popover (escapes the
// header's overflow-hidden). Active matching reuses findActiveNavHref so the
// two layouts always agree on "where am I".
//
// The bar is hidden below lg (the mobile drawer takes over there). Only one
// dropdown is open at a time; hover-to-open with a small close delay so the
// pointer can cross the gap between trigger and panel.

import { useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { Popover, cn } from '@openbooks/ui'
import { NavIcon, type SidebarNavGroup } from './sidebar-nav'
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
      className="hidden min-w-0 flex-1 items-center gap-0.5 lg:flex"
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
                  'flex h-14 items-center gap-1 whitespace-nowrap px-2.5 text-sm font-medium transition-colors',
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
              {group.items.map((item) => {
                const active = activeHref === item.href
                return (
                  <Link
                    key={item.href}
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
              })}
            </div>
          </Popover>
        )
      })}
    </nav>
  )
}
