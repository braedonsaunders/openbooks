'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  BookOpen,
  Building2,
  Calendar,
  Coins,
  Download,
  FileText,
  Hash,
  History,
  Landmark,
  Layers,
  MapPin,
  Percent,
  Receipt,
  Server,
  Shield,
  Tag,
  Timer,
  TrendingUp,
  Upload,
  Users,
  WalletCards,
} from 'lucide-react'
import { cn } from '@openbooks/ui'
import { SETUP_GROUPS, setupEntitiesByGroup } from '../../../../lib/setup/registry'

// iconKey → lucide component. Keys come from the registry (SETUP_GROUPS / entities).
const ICONS: Record<string, ReactNode> = {
  'book-open': <BookOpen size={15} />,
  building: <Building2 size={15} />,
  receipt: <Receipt size={15} />,
  percent: <Percent size={15} />,
  layers: <Layers size={15} />,
  file: <FileText size={15} />,
  tag: <Tag size={15} />,
  'map-pin': <MapPin size={15} />,
  hash: <Hash size={15} />,
  calendar: <Calendar size={15} />,
  timer: <Timer size={15} />,
  shield: <Shield size={15} />,
  landmark: <Landmark size={15} />,
  'trending-up': <TrendingUp size={15} />,
  coins: <Coins size={15} />,
  users: <Users size={15} />,
  server: <Server size={15} />,
  download: <Download size={15} />,
  upload: <Upload size={15} />,
  history: <History size={15} />,
  payments: <WalletCards size={15} />,
}

type NavItem = { href: string; label: string; iconKey: string }

/**
 * Left rail for the Setup workspace — grouped list of tabs, one per registry
 * entity plus the special-cased Company tab, followed by the Import & Export
 * links (permission-gated). Client component (needs the active pathname).
 * Setup labels resolve under `admin.setup`; the data links under `data`.
 */
export function SetupNav({ canExport, canImport, canManageSetup }: { canExport: boolean; canImport: boolean; canManageSetup: boolean }) {
  const t = useTranslations('admin.setup')
  const tClose = useTranslations('close.setup')
  const td = useTranslations('data')
  const tCrm = useTranslations('crm')
  const pathname = usePathname()
  const byGroup = setupEntitiesByGroup()

  const dataItems: NavItem[] = [
    ...(canExport ? [{ href: '/data/export', label: td('nav.export'), iconKey: 'download' }] : []),
    ...(canImport
      ? [
          { href: '/data/import', label: td('nav.import'), iconKey: 'upload' },
          { href: '/data/import/history', label: td('nav.history'), iconKey: 'history' },
        ]
      : []),
  ]

  return (
    <nav className="w-full" aria-label={t('title')}>
      <div className="space-y-5">
        {SETUP_GROUPS.map((group) => {
          if (!canManageSetup && group.key !== 'company') return null
          const items: NavItem[] =
            group.key === 'accounting'
              ? [
                  { href: '/admin/setup/period-close', label: tClose('title'), iconKey: 'calendar' },
                  ...(byGroup.get(group.key) ?? []).map((e) => ({
                    href: `/admin/setup/${e.key}`,
                    label: t(`entities.${e.key}.title`),
                    iconKey: e.iconKey,
                  })),
                ]
              : group.key === 'company'
              ? [
                  { href: '/admin/setup/company', label: t('entities.company.title'), iconKey: 'building' },
                  ...(byGroup.get(group.key) ?? []).map((e) => ({
                    href: `/admin/setup/${e.key}`,
                    label: t(`entities.${e.key}.title`),
                    iconKey: e.iconKey,
                  })),
                  { href: '/admin/setup/sftp', label: t('entities.sftp.title'), iconKey: 'server' },
                  { href: '/admin/setup/payment-operations', label: t('entities.payment-operations.title'), iconKey: 'payments' },
                  { href: '/admin/setup/crm', label: tCrm('setup.title'), iconKey: 'users' },
                ]
              : group.key === 'currency'
              ? [
                  { href: '/admin/setup/fx-provider', label: t('fxProvider.title'), iconKey: 'coins' },
                  ...(byGroup.get(group.key) ?? []).map((e) => ({
                    href: `/admin/setup/${e.key}`,
                    label: t(`entities.${e.key}.title`),
                    iconKey: e.iconKey,
                  })),
                ]
              : (byGroup.get(group.key) ?? []).map((e) => ({
                  href: `/admin/setup/${e.key}`,
                  label: t(`entities.${e.key}.title`),
                  iconKey: e.iconKey,
                }))
          const visibleItems = canManageSetup ? items : items.filter((item) => item.href === '/admin/setup/crm')
          if (visibleItems.length === 0) return null
          return (
            <div key={group.key} className="space-y-1">
              <h3 className="px-2 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                {t(`groups.${group.key}`)}
              </h3>
              <ul className="space-y-0.5">
                {visibleItems.map((item) => {
                  const active = pathname === item.href
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                          active
                            ? 'bg-teal-50 font-medium text-teal-700 dark:bg-teal-950/50 dark:text-teal-300'
                            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-100',
                        )}
                      >
                        <span className={cn('shrink-0', active ? 'text-teal-600 dark:text-teal-300' : 'text-slate-400')}>
                          {ICONS[item.iconKey] ?? <Tag size={15} />}
                        </span>
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}

        {dataItems.length > 0 && (
          <div className="space-y-1">
            <h3 className="px-2 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
              {td('nav.group')}
            </h3>
            <ul className="space-y-0.5">
              {dataItems.map((item) => {
                const active = pathname === item.href
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                        active
                          ? 'bg-teal-50 font-medium text-teal-700 dark:bg-teal-950/50 dark:text-teal-300'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-100',
                      )}
                    >
                      <span className={cn('shrink-0', active ? 'text-teal-600 dark:text-teal-300' : 'text-slate-400')}>
                        {ICONS[item.iconKey] ?? <Tag size={15} />}
                      </span>
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    </nav>
  )
}
