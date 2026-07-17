'use client'

// Native-style bottom tab bar, shown below lg. Tabs are the user's first nav
// destinations from the resolved permission-aware nav (so tenant nav
// customisation controls what lands here), plus a Menu tab that opens the
// full drawer. Sits in the shell's flex column (not fixed), so content never
// hides behind it; safe-area padding clears the iOS home indicator.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Menu } from 'lucide-react'
import { cn } from '@openbooks/ui'
import { useMobileNav } from './mobile-nav'
import { NavIcon, type SidebarNavGroup } from './sidebar-nav'
import { findActiveNavHref } from './sidebar-nav-active'
import { useNavGroups } from './use-platform-nav'
import { selectMobileTabs } from '../lib/mobile-nav'

const TAB_COUNT = 4

const tabClass = (active: boolean) =>
  cn(
    'flex min-w-0 flex-1 flex-col items-center gap-1 px-1 pt-2 pb-1.5 text-[10px] font-medium transition-colors',
    active
      ? 'text-teal-700 dark:text-teal-300'
      : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200',
  )

export function MobileTabBar({ groups }: { groups: SidebarNavGroup[] }) {
  const t = useTranslations('shell.mobileNav')
  const pathname = usePathname()
  const { setOpen } = useMobileNav()
  const navGroups = useNavGroups(groups)

  const tabs = selectMobileTabs(navGroups, TAB_COUNT)
  const activeHref = findActiveNavHref(pathname, [{ items: tabs }])

  if (tabs.length === 0) return null

  return (
    <nav
      aria-label={t('primaryAriaLabel')}
      className="flex shrink-0 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden dark:border-slate-800 dark:bg-slate-900"
    >
      {tabs.map((t) => {
        const active = activeHref === t.href
        return (
          <Link key={t.href} href={t.href as never} className={tabClass(active)}>
            <NavIcon iconKey={t.iconKey} size={20} />
            <span className="w-full truncate text-center">{t.label}</span>
          </Link>
        )
      })}
      <button type="button" onClick={() => setOpen(true)} className={tabClass(false)}>
        <Menu size={20} />
        <span className="w-full truncate text-center">{t('menu')}</span>
      </button>
    </nav>
  )
}
