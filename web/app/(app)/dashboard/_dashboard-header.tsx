import Link from 'next/link'
import { Settings2 } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

export async function DashboardHeader({
  greeting,
  tenantSummary,
}: {
  greeting: string
  tenantSummary?: string | null
}) {
  const t = await getTranslations('dashboard')
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
          {greeting}
        </h1>
        {tenantSummary ? (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{tenantSummary}</p>
        ) : null}
      </div>
      <Link
        href="/dashboard/customize"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        <Settings2 size={14} />
        <span>{t('header.customize')}</span>
      </Link>
    </header>
  )
}
