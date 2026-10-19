'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { BarChart3, CalendarRange, Settings2 } from 'lucide-react'
import { Button, Card } from '@openbooks/ui'
import type { ServiceHomeSummary } from '@openbooks/engine/service/reads'
import { APPROVALS_HOME_HREF } from '@openbooks/engine/navigation/approvals-home'

export type ServiceHomeProps = {
  summary: ServiceHomeSummary
  boards: readonly { code: string; name: string }[]
  reports: readonly { href: string; title: string }[]
  canConfigure: boolean
  canCreateBoard: boolean
}

/**
 * The service landing: the counts that need someone's attention, each a link
 * into the list that resolves it, the dispatch boards, and the analysis
 * reports in the Reports hub.
 */
export function ServiceHome({ summary, boards, reports, canConfigure, canCreateBoard }: ServiceHomeProps) {
  const t = useTranslations('service.home')
  const tiles: { key: keyof ServiceHomeSummary; href: string; tone?: 'warn' }[] = [
    { key: 'openRequests', href: '/service/requests' },
    { key: 'unscheduledVisits', href: '/service/visits?status=unscheduled' },
    { key: 'todayVisits', href: '/service/visits' },
    { key: 'inProgressVisits', href: '/service/visits?status=on_site' },
    { key: 'responseBreaches', href: '/service/visits', tone: 'warn' },
    { key: 'awaitingReview', href: APPROVALS_HOME_HREF },
    { key: 'readyToInvoice', href: '/service/jobs' },
    { key: 'quotesAwaitingAnswer', href: '/service/requests?status=quoted' },
    { key: 'activeAgreements', href: '/service/agreements' },
  ]
  return (
    <div className="space-y-6">
      {!summary.policyConfigured ? (
        <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="font-medium">{t('policyMissing')}</p>
          <p className="mt-1">{t('policyMissingRemedy')}</p>
          {canConfigure ? <Button asChild size="sm" variant="outline" className="mt-2"><Link href="/admin/setup/service-dispatch-policies">{t('openPolicy')}</Link></Button> : null}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {tiles.map((tile) => {
          const value = summary[tile.key] as number
          return (
            <Link key={tile.key} href={tile.href} className="rounded-xl border border-slate-200 bg-white p-4 transition hover:border-teal-400 dark:border-slate-800 dark:bg-slate-950">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{t(`tiles.${tile.key}`)}</p>
              <p className={`mt-1 text-2xl font-semibold tabular-nums ${tile.tone === 'warn' && value > 0 ? 'text-rose-600' : 'text-slate-900 dark:text-slate-100'}`}>{value}</p>
            </Link>
          )
        })}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100"><CalendarRange className="h-4 w-4" />{t('boards')}</h2>
          {boards.length ? (
            <ul className="mt-2 space-y-1">{boards.map((board) => <li key={board.code}><Link className="text-sm text-teal-700 hover:underline dark:text-teal-300" href={`/scheduling?board=${encodeURIComponent(board.code)}&view=dispatch`}>{board.name}</Link></li>)}</ul>
          ) : (
            <div className="mt-2 text-sm text-slate-500">
              <p>{t('noBoards')}</p>
              {canCreateBoard ? <Button asChild size="sm" variant="outline" className="mt-2"><Link href="/scheduling/boards"><Settings2 className="mr-1 h-4 w-4" />{t('createBoard')}</Link></Button> : null}
            </div>
          )}
        </Card>
        <Card className="p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100"><BarChart3 className="h-4 w-4" />{t('reports')}</h2>
          <ul className="mt-2 space-y-1">{reports.map((report) => <li key={report.href}><Link className="text-sm text-teal-700 hover:underline dark:text-teal-300" href={report.href}>{report.title}</Link></li>)}</ul>
        </Card>
      </div>
    </div>
  )
}
