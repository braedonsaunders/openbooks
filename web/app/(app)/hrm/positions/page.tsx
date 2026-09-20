import Link from 'next/link'
import { PageHeader, UrlDrawer } from '@openbooks/ui'
import { ModuleHomeTabs } from '../../../components/module-home/ui'
import { loadPositionsPage, positionsTitle } from './view'
import { PositionDrawerBody, PositionsTable } from './sections'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await positionsTitle() }
}

/**
 * Positions tab: the funded establishment as of a date with vacancy per
 * position. Status segments filter server-side; a row opens the position
 * drawer (versions, funding by period, current holder) through the URL, so
 * the selection is shareable and the drawer closes by navigation. Renders
 * only when the hrm feature gate is on and the actor holds
 * hrm.position.read — the loader 404s otherwise.
 */
export default async function PositionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; position?: string; effectiveDate?: string }>
}) {
  const data = await loadPositionsPage(await searchParams)
  const drawerOpen = data.detail !== null || data.missingDetail !== null
  return (
    <div className="space-y-6">
      <PageHeader title={data.title} description={data.description} />
      <ModuleHomeTabs tabs={data.tabs} />
      <nav aria-label={data.title} className="flex flex-wrap gap-2">
        {data.segments.map((segment) => (
          <Link
            key={segment.key}
            href={segment.href}
            aria-current={segment.active ? 'page' : undefined}
            className={
              segment.active
                ? 'rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white dark:bg-slate-100 dark:text-slate-900'
                : 'rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:border-slate-400 dark:border-slate-700 dark:text-slate-300'
            }
          >
            {segment.label} · {segment.count}
          </Link>
        ))}
      </nav>
      <PositionsTable
        columns={data.columns}
        rows={data.rows}
        empty={data.empty}
        totals={data.totals}
        totalLabel={data.totalLabel}
      />
      <UrlDrawer
        open={drawerOpen}
        closeHref={data.detail?.closeHref ?? '/hrm/positions'}
        title={data.detail ? data.detail.code : data.title}
        description={data.detail ? data.detail.title : undefined}
      >
        {data.detail ? (
          <PositionDrawerBody detail={data.detail} />
        ) : data.missingDetail ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{data.missingDetail}</p>
        ) : null}
      </UrlDrawer>
    </div>
  )
}
