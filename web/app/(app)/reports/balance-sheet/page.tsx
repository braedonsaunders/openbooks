import { getTranslations } from 'next-intl/server'
import { Badge, Card, CardContent, PageHeader, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { dimensionOptions } from '../../../../lib/reports'
import { balanceSheetView } from '../../../../lib/statement-matrix'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery, scaleFactor } from '../../../../lib/report-filters'
import { money } from '../../../../lib/format'
import { StatementMatrixTable } from '../StatementMatrixTable'
import { StatementExport } from '../StatementExport'
import { ReportFilterBar } from '../ReportFilterBar'
import { SaveViewButton } from '../SaveViewButton'

export const dynamic = 'force-dynamic'

export default async function BalanceSheet({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('reports')
  const sp = await searchParams
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  const secTotal = (section: string) => t('statement.sectionTotal', { section })
  const labels = {
    assets: t('balanceSheet.assets'),
    liabilities: t('balanceSheet.liabilities'),
    equity: t('balanceSheet.equity'),
    totalAssets: secTotal(t('balanceSheet.assets')),
    totalLiabilities: secTotal(t('balanceSheet.liabilities')),
    totalEquity: secTotal(t('balanceSheet.equity')),
    accumulatedEarnings: t('statement.accumulatedEarnings'),
    liabilitiesAndEquity: t('balanceSheet.liabilitiesAndEquity'),
    totalOf: secTotal,
  }

  const [view, opts] = await Promise.all([
    balanceSheetView({ from: period.from, to: period.to }, period.label, labels, {
      breakout: q.breakout,
      compare: q.compare,
      basis: q.basis,
      dims: q.dims,
      showZero: q.showZero,
    }),
    dimensionOptions(),
  ])

  const valueOf = (label: string) => view.lines.find((l) => l.label === label)?.values?.[0] ?? 0
  const totalAssets = valueOf(labels.totalAssets)
  const totalLiabilities = valueOf(labels.totalLiabilities)
  const totalEquity = valueOf(labels.totalEquity)
  const balanced = Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('balanceSheet.title')}
            description={t('balanceSheet.asOf', { date: period.to })}
            back={{ href: '/reports', label: t('hub.title') }}
            actions={
              <>
                <SaveViewButton />
                <StatementExport kind="balance-sheet" params={sp} />
              </>
            }
          />
          <ReportFilterBar
            controls={{
              period: true,
              asOf: true,
              breakout: true,
              breakoutOptions: ['department', 'project', 'location', 'class', 'month', 'quarter'],
              compare: true,
              basis: true,
              dimensions: true,
              showZero: true,
              scale: true,
            }}
            dimensions={opts}
          />
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              { label: t('balanceSheet.assets'), value: money(totalAssets) },
              { label: t('balanceSheet.liabilities'), value: money(totalLiabilities) },
              { label: t('balanceSheet.equity'), value: money(totalEquity) },
            ].map((s) => (
              <Card key={s.label}>
                <CardContent className="p-4">
                  <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{s.label}</span>
                  <span className="block text-xl font-semibold tabular-nums">{s.value}</span>
                </CardContent>
              </Card>
            ))}
            <Card>
              <CardContent className="p-4">
                <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
                  {t('balanceSheet.equation')}
                </span>
                <span className={cn('mt-1 inline-block')}>
                  <Badge variant={balanced ? 'success' : 'destructive'}>
                    {balanced
                      ? t('balanceSheet.balanced')
                      : t('balanceSheet.offBy', { amount: money(totalAssets - totalLiabilities - totalEquity) })}
                  </Badge>
                </span>
              </CardContent>
            </Card>
          </div>
        </>
      }
    >
      <StatementMatrixTable view={view} scale={q.scale} periodQs={`?to=${period.to}`} />
    </ListPageLayout>
  )
}
