import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { dimensionOptions, trialBalance } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { reportSubsidiaryView } from '../../../../lib/consolidation'
import { orgBranding } from '../../../../lib/report-pdf'
import { decimalAdd, decimalNeg, decimalSum } from '../../../../lib/statement-format'
import { ReportFilterBar } from '../ReportFilterBar'
import { ExportMenu } from '../ExportMenu'
import { SaveViewButton } from '../SaveViewButton'
import { ScheduleReportButton } from '../ScheduleReportButton'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import { PaperView, type PaperCell } from '../PaperView'
import type { ReportDrillTarget } from '../../../../lib/report-drill'
import { mergeHref } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'

export default async function TrialBalance({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('reports')
  const sp = await searchParams
  const scheduleDefId = await reportScheduleAnchor('trial-balance')
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const date = period.to
  const subView = await reportSubsidiaryView(q.subsidiaryId, date)
  const dims = { ...q.dims, subsidiaryIds: subView.subsidiary?.ids }
  const [rows, opts, org, branding] = await Promise.all([trialBalance(date, dims), dimensionOptions(), orgInfo(), orgBranding()])
  const totalDebits = decimalSum(rows.map((r) => r.debits))
  const totalCredits = decimalSum(rows.map((r) => r.credits))

  // The unified report shape: every value drills to the account register as of
  // the report date (five-cell rows share one href).
  const dataRows: PaperCell[][] = rows.map((r) => [r.number, r.name, r.debits, r.credits, r.balance])
  const links = rows.map((r) => {
    const registerHref = mergeHref('/reports/trial-balance', sp, {
      accountRegister: r.id,
      accountRegisterPage: undefined,
      accountRegisterFrom: undefined,
      accountRegisterTo: date,
    })
    return [registerHref, registerHref, null, null, null]
  })
  const drills: (ReportDrillTarget | null)[][] = rows.map((r) => {
    const target: ReportDrillTarget = {
      kind: 'ledger',
      label: `${r.number ?? ''} ${r.name}`.trim(),
      accountIds: [r.id],
      to: date,
      mode: 'balance',
      dims,
      subsidiaryId: q.subsidiaryId,
    }
    return [null, null, target, target, target]
  })
  dataRows.push(['', t('trialBalance.totals'), totalDebits, totalCredits, decimalAdd(totalDebits, decimalNeg(totalCredits))])
  links.push([null, null, null, null, null])
  const totalsTarget: ReportDrillTarget = { kind: 'ledger', label: t('trialBalance.totals'), to: date, mode: 'balance', dims, subsidiaryId: q.subsidiaryId }
  drills.push([null, null, totalsTarget, totalsTarget, totalsTarget])

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader title={t('trialBalance.title')} back={{ href: '/reports', label: t('hub.title') }} />
          <ReportFilterBar
            controls={{ period: true, asOf: true, dimensions: true, subsidiary: true }}
            subsidiaries={subView.picker}
            dimensions={opts}
            actions={<>{scheduleDefId ? <ScheduleReportButton definitionId={scheduleDefId} statementParams={scheduleParamsFrom(sp)} /> : null}<SaveViewButton /><ExportMenu kind="trial-balance" params={sp} /></>}
          />
        </>
      }
    >
      <PaperView
        company={branding.orgName}
        currency={org?.base_currency}
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
              drills,
              totalRowIndex: dataRows.length - 1,
            },
          ],
        }}
      />
    </ListPageLayout>
  )
}
