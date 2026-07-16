import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { dimensionOptions, trialBalance } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { currencySymbol } from '../../../../lib/statement-format'
import { orgBranding } from '../../../../lib/report-pdf'
import { ReportFilterBar } from '../ReportFilterBar'
import { ExportMenu } from '../ExportMenu'
import { SaveViewButton } from '../SaveViewButton'
import { PaperView, type PaperCell } from '../PaperView'

export const dynamic = 'force-dynamic'

export default async function TrialBalance({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('reports')
  const sp = await searchParams
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const date = period.to
  const dims = { departmentId: q.dims.departmentId, projectId: q.dims.projectId }
  const [rows, opts, org, branding] = await Promise.all([trialBalance(date, dims), dimensionOptions(), orgInfo(), orgBranding()])
  const sym = currencySymbol(org?.base_currency)
  const totalDebits = rows.reduce((a, r) => a + Number(r.debits), 0)
  const totalCredits = rows.reduce((a, r) => a + Number(r.credits), 0)

  // The unified report shape: every value drills to the account register as of
  // the report date (five-cell rows share one href).
  const dataRows: PaperCell[][] = rows.map((r) => [r.number, r.name, Number(r.debits), Number(r.credits), Number(r.balance)])
  const links = rows.map((r) => Array(5).fill(`/accounts/${r.id}?to=${date}`))
  dataRows.push(['', t('trialBalance.totals'), totalDebits, totalCredits, totalDebits - totalCredits])
  links.push([null, null, null, null, null])

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader title={t('trialBalance.title')} back={{ href: '/reports', label: t('hub.title') }} />
          <ReportFilterBar
            controls={{ period: true, asOf: true, dimensions: true }}
            dimensions={opts}
            actions={<><SaveViewButton /><ExportMenu kind="trial-balance" params={sp} /></>}
          />
        </>
      }
    >
      <PaperView
        company={branding.orgName}
        currency={sym}
        emptyLabel={t('generalLedger.empty')}
        data={{
          title: t('trialBalance.title'),
          periodPhrase: t('trialBalance.description', { date, count: rows.length }),
          groups: [
            {
              columns: [
                t('export.columns.accountNumber'),
                t('export.columns.accountName'),
                t('trialBalance.columns.debits'),
                t('trialBalance.columns.credits'),
                t('export.columns.balance'),
              ],
              align: ['left', 'left', 'right', 'right', 'right'],
              money: [false, false, true, true, true],
              rows: dataRows,
              links,
            },
          ],
        }}
      />
    </ListPageLayout>
  )
}
