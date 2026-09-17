'use client'

// Platform workspace switcher body — rendered inside the account menu.
// Lists the organization workspace and the operator console, matching the
// AppKit PlatformMenu options without a second header popover.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { isPlatformPath } from '@braedonsaunders/appkit-superadmin'
import { Building2, Check, Shield, type LucideIcon } from 'lucide-react'
import { cn } from '@openbooks/ui'

export function useOnPlatform(): boolean {
  return isPlatformPath(usePathname() ?? '')
}

export function PlatformWorkspacePicker({
  onNavigate,
}: {
  onNavigate?: () => void
}) {
  const t = useTranslations('shell.accountMenu')
  const onPlatform = useOnPlatform()

  const options: Array<{
    key: 'tenant' | 'platform'
    href: string
    label: string
    hint: string
    icon: LucideIcon
    active: boolean
  }> = [
    {
      key: 'tenant',
      href: '/',
      label: t('organizationWorkspace'),
      hint: t('organizationWorkspaceDescription'),
      icon: Building2,
      active: !onPlatform,
    },
    {
      key: 'platform',
      href: '/platform',
      label: t('platform'),
      hint: t('platformDescription'),
      icon: Shield,
      active: onPlatform,
    },
  ]

  return (
    <div className="p-1">
      {options.map((option) => {
        const Icon = option.icon
        return (
          <Link
            key={option.key}
            href={option.href}
            role="menuitemradio"
            aria-checked={option.active}
            onClick={onNavigate}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60"
          >
            <Check
              size={15}
              className={cn(
                'shrink-0',
                option.active ? 'text-teal-600 dark:text-teal-400' : 'text-transparent',
              )}
            />
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
              <Icon size={15} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{option.label}</span>
              <span className="truncate text-[11px] text-slate-400 dark:text-slate-500">{option.hint}</span>
            </span>
          </Link>
        )
      })}
    </div>
  )
}
