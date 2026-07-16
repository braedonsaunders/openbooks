import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { dimensionOptions, projectProfitability } from '../../../../lib/reports'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery, toSearchParams } from '../../../../lib/report-filters'
import { money } from '../../../../lib/format'
import { ReportFilterBar } from '../ReportFilterBar'
import { SaveViewButton } from '../SaveViewButton'
import { ExportMenu } from '../ExportMenu'

export const dynamic = 'force-dynamic'

const pct = (m: number | null) => (m === null ? '—' : `${(m * 100).toFixed(1)}%`)

export default async function ProjectProfitabilityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('reports')
  const sp = await searchParams
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const dims = {
    departmentId: q.dims.departmentId,
    projectId: q.dims.projectId,
    locationId: q.dims.locationId,
    classId: q.dims.classId,
  }
  const [result, opts] = await Promise.all([
    projectProfitability(period.from, period.to, { dims }),
    dimensionOptions(),
  ])

  // Each project row drills into the full P&L filtered on that project, keeping
  // the current period/basis/other-dimension context.
  const pnlHref = (projectId: string) =>
    `/reports/pnl?${toSearchParams({ ...q, dims: { ...q.dims, projectId } }).toString()}`

  const num = (v: number, danger = false) => (
    <TableCell className={cn('text-right tabular-nums', danger && v < 0 && 'text-red-600 dark:text-red-400')}>
      {money(v)}
    </TableCell>
  )

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('projectProfitability.title')}
            description={t('pnl.dateRange', { from: period.from, to: period.to })}
            back={{ href: '/reports', label: t('hub.title') }}
            actions={
              <div className="flex items-center gap-2">
                <SaveViewButton />
                <ExportMenu kind="project-profitability" params={sp} />
              </div>
            }
          />
          <ReportFilterBar controls={{ period: true, dimensions: true }} dimensions={opts} />
        </>
      }
    >
      {result.rows.length === 0 ? (
        <p className="py-8 text-center text-slate-400 italic">{t('projectProfitability.empty')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('projectProfitability.columns.project')}</TableHead>
              <TableHead>{t('projectProfitability.columns.customer')}</TableHead>
              <TableHead className="text-right">{t('projectProfitability.columns.revenue')}</TableHead>
              <TableHead className="text-right">{t('projectProfitability.columns.cogs')}</TableHead>
              <TableHead className="text-right">{t('projectProfitability.columns.grossProfit')}</TableHead>
              <TableHead className="text-right">{t('projectProfitability.columns.expenses')}</TableHead>
              <TableHead className="text-right">{t('projectProfitability.columns.net')}</TableHead>
              <TableHead className="text-right">{t('projectProfitability.columns.margin')}</TableHead>
              <TableHead className="text-right">{t('projectProfitability.columns.hours')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((r) => (
              <TableRow key={r.projectId}>
                <TableCell>
                  <Link href={pnlHref(r.projectId)} className="font-medium hover:text-teal-700 dark:hover:text-teal-300">
                    {r.projectName}
                  </Link>
                </TableCell>
                <TableCell className="text-slate-600 dark:text-slate-300">{r.customerName ?? '—'}</TableCell>
                {num(r.revenue)}
                {num(r.cogs)}
                {num(r.grossProfit, true)}
                {num(r.expenses)}
                {num(r.net, true)}
                <TableCell className={cn('text-right tabular-nums', r.margin !== null && r.margin < 0 && 'text-red-600 dark:text-red-400')}>
                  {pct(r.margin)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.hours ? r.hours.toLocaleString() : ''}</TableCell>
              </TableRow>
            ))}
            <TableRow className="border-t-2 font-semibold">
              <TableCell colSpan={2}>{t('trialBalance.totals')}</TableCell>
              {num(result.totals.revenue)}
              {num(result.totals.cogs)}
              {num(result.totals.grossProfit, true)}
              {num(result.totals.expenses)}
              {num(result.totals.net, true)}
              <TableCell className="text-right tabular-nums">{pct(result.totals.margin)}</TableCell>
              <TableCell className="text-right tabular-nums">{result.totals.hours ? result.totals.hours.toLocaleString() : ''}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </ListPageLayout>
  )
}
