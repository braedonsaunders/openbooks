import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { dimensionOptions } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { profitAndLossView } from '../../../../lib/statement-matrix'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery, scaleFactor } from '../../../../lib/report-filters'
import { StatementMatrixTable } from '../StatementMatrixTable'
import { StatementPaper } from '../StatementPaper'
import { ExportMenu } from '../ExportMenu'
import { ReportFilterBar } from '../ReportFilterBar'
import { SaveViewButton } from '../SaveViewButton'

export const dynamic = 'force-dynamic'

export default async function PnL({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const t = await getTranslations('reports')
  const sp = await searchParams
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  const labels = {
    revenue: t('pnl.revenue'),
    costOfGoodsSold: t('pnl.costOfGoodsSold'),
    grossProfit: t('pnl.grossProfit'),
    expenses: t('pnl.expenses'),
    netIncome: t('pnl.netIncome'),
    totalOf: (section: string) => t('statement.sectionTotal', { section }),
  }

  const [view, opts, org] = await Promise.all([
    profitAndLossView({ from: period.from, to: period.to }, period.label, labels, {
      breakout: q.breakout,
      compare: q.compare,
      basis: q.basis,
      dims: q.dims,
      showZero: q.showZero,
    }),
    dimensionOptions(),
    orgInfo(),
  ])

  const scale = scaleFactor(q.scale)
  const backParams = new URLSearchParams()
  for (const [k, v] of Object.entries(sp)) if (v) backParams.set(k, v)
  const backHref = `/reports/pnl${backParams.toString() ? `?${backParams}` : ''}`

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('pnl.title')}
            description={`${period.label}${scale.note ? ` · ${scale.note.toLowerCase()}` : ''}`}
            back={{ href: '/reports', label: t('hub.title') }}
          />
          <ReportFilterBar
            controls={{
              period: true,
              breakout: true,
              compare: true,
              basis: true,
              dimensions: true,
              showZero: true,
              scale: true,
            }}
            dimensions={opts}
            actions={
              <>
                <SaveViewButton />
                <ExportMenu kind="pnl" params={sp} />
              </>
            }
          />
          {view.truncated && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t('filterBar.truncated')}</p>
          )}
        </>
      }
    >
      <StatementPaper
        company={org?.name ?? 'openbooks'}
        title={t('pnl.title')}
        periodPhrase={t('pnl.dateRange', { from: period.from, to: period.to })}
        note={scale.note || undefined}
      >
        <StatementMatrixTable
          view={view}
          scale={q.scale}
          currency={org?.base_currency}
          drill={{ dims: q.dims, basis: q.basis, back: backHref, backLabel: t('pnl.title') }}
        />
      </StatementPaper>
    </ListPageLayout>
  )
}
