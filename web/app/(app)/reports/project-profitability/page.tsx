import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { dimensionOptions, projectProfitability } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery, toSearchParams } from '../../../../lib/report-filters'
import { currencySymbol } from '../../../../lib/statement-format'
import { orgBranding } from '../../../../lib/report-pdf'
import { ReportFilterBar } from '../ReportFilterBar'
import { SaveViewButton } from '../SaveViewButton'
import { ExportMenu } from '../ExportMenu'
import { PaperView, type PaperCell } from '../PaperView'

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
  const dims = q.dims
  const [result, opts, org, branding] = await Promise.all([
    projectProfitability(period.from, period.to, { dims }),
    dimensionOptions(),
    orgInfo(),
    orgBranding(),
  ])
  const sym = currencySymbol(org?.base_currency)

  // Each project drills into the P&L filtered on that project (period + basis +
  // other dims preserved). Link only the project-name cell.
  const pnlHref = (projectId: string) =>
    `/reports/pnl?${toSearchParams({ ...q, dims: { ...q.dims, projectId } }).toString()}`

  const rows: PaperCell[][] = result.rows.map((r) => [
    r.projectName,
    r.customerName ?? '—',
    r.revenue,
    r.cogs,
    r.grossProfit,
    r.expenses,
    r.net,
    pct(r.margin),
    r.hours || '',
  ])
  const links = result.rows.map((r) => [pnlHref(r.projectId), null, null, null, null, null, null, null, null])
  const T = result.totals
  rows.push([t('trialBalance.totals'), '', T.revenue, T.cogs, T.grossProfit, T.expenses, T.net, pct(T.margin), T.hours || ''])
  links.push([null, null, null, null, null, null, null, null, null])

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('projectProfitability.title')}
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
      <PaperView
        company={branding.orgName}
        currency={sym}
        emptyLabel={t('projectProfitability.empty')}
        data={{
          title: t('projectProfitability.title'),
          periodPhrase: t('pnl.dateRange', { from: period.from, to: period.to }),
          groups: [
            {
              columns: [
                t('projectProfitability.columns.project'),
                t('projectProfitability.columns.customer'),
                t('projectProfitability.columns.revenue'),
                t('projectProfitability.columns.cogs'),
                t('projectProfitability.columns.grossProfit'),
                t('projectProfitability.columns.expenses'),
                t('projectProfitability.columns.net'),
                t('projectProfitability.columns.margin'),
                t('projectProfitability.columns.hours'),
              ],
              align: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
              money: [false, false, true, true, true, true, true, false, false],
              rows,
              links,
              isEmpty: result.rows.length === 0,
            },
          ],
        }}
      />
    </ListPageLayout>
  )
}
