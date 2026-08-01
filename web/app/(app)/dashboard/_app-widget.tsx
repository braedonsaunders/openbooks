'use client'

import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { NavIcon } from '@/components/sidebar-nav'
import { useTranslations } from 'next-intl'

export type DashboardApp = {
  key: string
  name: string
  description: string
  iconKey: string
}

/** A host-rendered launcher card. App code still runs only on its isolated
 * runtime screen; placing a card never grants the app new ambient access. */
export function AppWidgetCard({ app }: { app: DashboardApp }) {
  const t = useTranslations('apps')
  return (
    <Link
      href={`/apps/${encodeURIComponent(app.key)}`}
      className="group flex h-full flex-col justify-between overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-teal-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-900 dark:hover:border-teal-800/70"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700 ring-1 ring-teal-100 ring-inset dark:bg-teal-950/60 dark:text-teal-300 dark:ring-teal-900">
          <NavIcon iconKey={app.iconKey} size={19} />
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{app.name}</h3>
          <p className="mt-1 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
            {app.description || t('noDescription')}
          </p>
        </div>
      </div>
      <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-teal-700 dark:text-teal-300">
        {t('actions.open')}
        <ArrowUpRight size={13} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
      </span>
    </Link>
  )
}
