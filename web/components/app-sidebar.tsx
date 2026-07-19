'use client'

// The desktop nav rail. Collapses to an icon-only strip; the choice is persisted
// in a cookie so the server can render the correct width on the next load (no
// width flash). Hosts the brand, the nav, the theme switcher, and the version tag.

import { useCallback, useState } from 'react'
import { useTranslations } from 'next-intl'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Badge, cn } from '@openbooks/ui'
import { BrandHomeLink } from './brand-home-link'
import { SidebarNav, type SidebarNavGroup } from './sidebar-nav'
import { useNavGroups } from './use-platform-nav'
import { ThemeToggle } from './theme-toggle'

const COOKIE = 'sidebar_collapsed'

export function AppSidebar({
  groups,
  defaultCollapsed = false,
}: {
  groups: SidebarNavGroup[]
  defaultCollapsed?: boolean
}) {
  const t = useTranslations('shell.sidebar')
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const navGroups = useNavGroups(groups)

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

  return (
    <aside
      className={cn(
        'hidden shrink-0 flex-col border-r border-slate-200 bg-white transition-[width] duration-200 ease-out lg:flex',
        'dark:border-slate-800 dark:bg-slate-900',
        collapsed ? 'w-[4.25rem]' : 'w-60',
      )}
    >
      <div
        className={cn(
          'flex h-14 items-center border-b border-slate-200 px-3 dark:border-slate-800',
          collapsed ? 'justify-center' : 'gap-2',
        )}
      >
        {collapsed ? null : <BrandHomeLink />}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? t('expand') : t('collapse')}
          title={collapsed ? t('expand') : t('collapse')}
          className={cn(
            'grid h-8 w-8 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200',
            collapsed ? '' : 'ml-auto',
          )}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>

      <SidebarNav groups={navGroups} collapsed={collapsed} />

      <div className="border-t border-slate-200 p-3 dark:border-slate-800">
        {collapsed ? (
          <div className="flex justify-center">
            <ThemeToggle collapsed />
          </div>
        ) : (
          <div className="space-y-2">
            <ThemeToggle />
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>v0.1.0</span>
              <Badge variant="secondary" className="font-mono text-[10px]">
                dev
              </Badge>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
