import { getTranslations } from 'next-intl/server'
import { Card, CardContent, PageHeader, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { dimensionOptions } from '../../../../lib/reports'
import { profitAndLossView } from '../../../../lib/statement-matrix'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery, scaleFactor } from '../../../../lib/report-filters'
import { money } from '../../../../lib/format'
import { StatementMatrixTable } from '../StatementMatrixTable'
import { StatementExport } from '../StatementExport'
import { ReportFilterBar } from '../ReportFilterBar'
import { SaveViewButton } from '../SaveViewButton'

export const dynamic = 'force-dynamic'

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{label}</span>
        <span
          className={cn(
            'block text-xl font-semibold tabular-nums',
            tone === 'good' && 'text-teal-700 dark:text-teal-300',
            tone === 'bad' && 'text-red-600 dark:text-red-400',
          )}
        >
          {money(value)}
        </span>
      </CardContent>
    </Card>
  )
}

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

  const [view, opts] = await Promise.all([
    profitAndLossView({ from: period.from, to: period.to }, period.label, labels, {
      breakout: q.breakout,
      compare: q.compare,
      basis: q.basis,
      dims: q.dims,
      showZero: q.showZero,
    }),
    dimensionOptions(),
  ])

  // Headline stats from the primary (first) column of the assembled view.
  const primary = (line: 'revenue' | 'grossProfit' | 'netIncome') => {
    const map: Record<string, string> = {
      revenue: labels.totalOf(labels.revenue),
      grossProfit: labels.grossProfit,
      netIncome: labels.netIncome,
    }
    const row = view.lines.find((l) => l.label === map[line] && (l.kind === 'subtotal' || l.kind === 'total'))
    return row?.values?.[0] ?? 0
  }

  const periodQs = new URLSearchParams({ from: period.from, to: period.to }).toString()
  const scale = scaleFactor(q.scale)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('pnl.title')}
            description={`${period.label}${scale.note ? ` · ${scale.note.toLowerCase()}` : ''}`}
            back={{ href: '/reports', label: t('hub.title') }}
            actions={
              <>
                <SaveViewButton />
                <StatementExport kind="pnl" params={sp} />
              </>
            }
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
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label={t('pnl.revenue')} value={primary('revenue')} />
            <Stat label={t('pnl.grossProfit')} value={primary('grossProfit')} />
            <Stat label={t('pnl.netIncome')} value={primary('netIncome')} tone={primary('netIncome') >= 0 ? 'good' : 'bad'} />
          </div>
          {view.truncated && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t('filterBar.truncated')}</p>
          )}
        </>
      }
    >
      <StatementMatrixTable view={view} scale={q.scale} periodQs={`?${periodQs}`} />
    </ListPageLayout>
  )
}
