'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { cn } from '@openbooks/ui'
import { NavIcon, type SidebarNavItem } from './sidebar-nav'

/** Compact utility navigation for destinations that should remain available
 * without consuming a primary top-menu workspace. */
export function HeaderNavLink({
  item,
  ariaLabel = item.label,
  title = item.label,
}: {
  item: SidebarNavItem
  ariaLabel?: string
  title?: string
}) {
  const pathname = usePathname() ?? ''
  const active = pathname === item.href || pathname.startsWith(`${item.href}/`)

  return (
    <Link
      href={item.href as never}
      aria-label={ariaLabel}
      title={title}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'grid h-9 w-9 shrink-0 place-items-center rounded-md transition-colors',
        active
          ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300'
          : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100',
        'focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none',
      )}
    >
      <NavIcon iconKey={item.iconKey} size={18} />
    </Link>
  )
}

export function AppLauncherLink({ item }: { item: SidebarNavItem }) {
  const t = useTranslations('shell.apps')
  return <HeaderNavLink item={item} ariaLabel={t('ariaLabel')} title={t('title')} />
}
