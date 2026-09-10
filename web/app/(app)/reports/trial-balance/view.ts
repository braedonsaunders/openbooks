import 'server-only'

import { getTranslations } from 'next-intl/server'
import { dimensionOptions, trialBalance } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { reportSubsidiaryView } from '../../../../lib/consolidation'
import { orgBranding } from '../../../../lib/report-pdf'
import { decimalAdd, decimalNeg, decimalSum } from '../../../../lib/statement-format'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import type { ReportDrillTarget } from '../../../../lib/report-drill'
import type { PaperCell } from '../PaperView'
import { mergeHref } from '../../../../lib/list-params'
import { filterBar, page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'

/**
 * The trial balance, split into a loader and a spec.
 *
 * Its body is one `PaperView` — a whole component that owns the paper chrome,
 * the column alignment and the money formatting for a generic tabular report.
 * The spec places it and binds the data the loader already assembled; the
 * header and filter bar are ordinary blocks.
 */

export interface TrialBalanceData {
  title: string
  backHref: string
  backLabel: string
  dimensions: unknown
  subsidiaries: unknown
  scheduleDefId: string | null
  scheduleParams: Record<string, string | undefined>
  exportParams: Record<string, string | undefined>
  company: string
  currency: string | undefined
  emptyLabel: string
  paper: unknown
}

export async function loadTrialBalance(
  sp: Record<string, string | undefined>,
): Promise<TrialBalanceData> {
  const t = await getTranslations('reports')
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


  return {
    title: t('trialBalance.title'),
    backHref: '/reports',
    backLabel: t('hub.title'),
    dimensions: opts,
    subsidiaries: subView.picker,
    scheduleDefId,
    scheduleParams: scheduleParamsFrom(sp),
    exportParams: sp,
    company: branding.orgName,
    currency: org?.base_currency,
    emptyLabel: t('generalLedger.empty'),
    paper: {
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
    },
  }
}

const f = ref<TrialBalanceData>()

export function trialBalanceSpec(data: TrialBalanceData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({ title: f('title'), back: { href: f('backHref'), label: f('backLabel') } }),
      filterBar(
        { period: true, asOf: true, dimensions: true, subsidiary: true },
        {
          dimensions: f('dimensions'),
          subsidiaries: f('subsidiaries'),
          actions: [
            widget(
              'schedule-report',
              { definitionId: data.scheduleDefId ?? '', statementParams: data.scheduleParams },
              f('scheduleDefId'),
            ),
            widget('save-view'),
            widget('export-menu', { kind: 'trial-balance', params: data.exportParams }),
          ],
        },
      ),
    ],
    body: [
      widgetBlock('paper-view', {
        company: data.company,
        currency: data.currency,
        emptyLabel: data.emptyLabel,
        data: data.paper,
      }),
    ],
  })
}
