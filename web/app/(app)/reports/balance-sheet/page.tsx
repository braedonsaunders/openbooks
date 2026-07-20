import { getTranslations } from 'next-intl/server'
import { Badge, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { dimensionOptions } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { reportSubsidiaryView } from '../../../../lib/consolidation'
import { balanceSheetView } from '../../../../lib/statement-matrix'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery, scaleFactor } from '../../../../lib/report-filters'
import { money } from '../../../../lib/format'
import { StatementMatrixTable } from '../StatementMatrixTable'
import { ReportPaper } from '../ReportPaper'
import { ExportMenu } from '../ExportMenu'
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
    translationAdjustment: t('statement.translationAdjustment'),
    liabilitiesAndEquity: t('balanceSheet.liabilitiesAndEquity'),
    totalOf: secTotal,
  }

  const subView = await reportSubsidiaryView(q.subsidiaryId, period.to)
  const [view, opts, org] = await Promise.all([
    balanceSheetView({ from: period.from, to: period.to }, period.label, labels, {
      breakout: q.breakout,
      compare: q.compare,
      basis: q.basis,
      dims: q.dims,
      subsidiary: subView.subsidiary,
      showZero: q.showZero,
    }),
    dimensionOptions(),
    orgInfo(),
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
            description={`${subView.label ? `${subView.label} · ` : ''}${t('balanceSheet.asOf', { date: period.to })}`}
            back={{ href: '/reports', label: t('hub.title') }}
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
              subsidiary: true,
              showZero: true,
              scale: true,
              sections: true,
            }}
            dimensions={opts}
            subsidiaries={subView.picker}
            actions={
              <>
                <SaveViewButton />
                <ExportMenu kind="balance-sheet" params={sp} />
              </>
            }
          />
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>{t('balanceSheet.equation')}</span>
            <Badge variant={balanced ? 'success' : 'destructive'}>
              {balanced
                ? t('balanceSheet.balanced')
                : t('balanceSheet.offBy', { amount: money(totalAssets - totalLiabilities - totalEquity) })}
            </Badge>
          </div>
        </>
      }
    >
      <ReportPaper
        company={org?.name ?? ''}
        title={t('balanceSheet.title')}
        periodPhrase={t('balanceSheet.asOf', { date: period.to })}
        note={scaleFactor(q.scale).note || undefined}
        wide={view.columns.length > 4}
      >
        <StatementMatrixTable
          view={view}
          scale={q.scale}
          currency={subView.currency ?? org?.base_currency}
          drill={{
            dims: q.dims,
            basis: q.basis,
            subsidiaryId: q.subsidiaryId,
          }}
        />
      </ReportPaper>
    </ListPageLayout>
  )
}
