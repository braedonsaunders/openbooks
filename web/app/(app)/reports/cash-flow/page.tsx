import { getMoneyFormatter } from '@/lib/money-server'
import { getTranslations } from 'next-intl/server'
import { Badge, PageHeader, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { cashFlow, dimensionOptions, type CashFlowSection } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { ReportFilterBar } from '../ReportFilterBar'
import { ExportMenu } from '../ExportMenu'
import { SaveViewButton } from '../SaveViewButton'
import { ScheduleReportButton } from '../ScheduleReportButton'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import { ReportPaper } from '../ReportPaper'
import { Table, TableBody, TableCell, TableRow, reportSubtotalRowClass, reportTotalRowClass } from '../ReportTable'
import { ReportDrillLink } from '../ReportDrillLink'
import type { StatementDimFilter } from '../../../../lib/statement-matrix'
import { decimalCmp, decimalIsMaterial, type ExactDecimal } from '../../../../lib/statement-format'

export const dynamic = 'force-dynamic'

const SECTION_ORDER: CashFlowSection[] = ['operating', 'investing', 'financing']

export default async function CashFlow({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('reports.cashFlow')
  const tr = await getTranslations('reports')
  const sp = await searchParams
  const scheduleDefId = await reportScheduleAnchor('cash-flow')
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const from = period.from
  const to = period.to
  const dims = q.dims
  const [cf, opts, org] = await Promise.all([cashFlow(from, to, dims), dimensionOptions(), orgInfo()])
  const m = (v: ExactDecimal) => money(v, { currency: org?.base_currency })
  const openingTo = new Date(`${from}T00:00:00Z`)
  openingTo.setUTCDate(openingTo.getUTCDate() - 1)
  const openingDate = openingTo.toISOString().slice(0, 10)

  const sectionLabels: Record<CashFlowSection, string> = {
    operating: t('sections.operating'),
    investing: t('sections.investing'),
    financing: t('sections.financing'),
  }
  const reconciled = !decimalIsMaterial(cf.reconciliationGap, '0.0100')
  const hasMovements = cf.sections.some((s) => s.lines.length > 0)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('title')}
            back={{ href: '/reports', label: tr('hub.title') }}
          />
          <ReportFilterBar
            controls={{ period: true, dimensions: true }}
            dimensions={opts}
            actions={<>{scheduleDefId ? <ScheduleReportButton definitionId={scheduleDefId} statementParams={scheduleParamsFrom(sp)} /> : null}<SaveViewButton /><ExportMenu kind="cash-flow" params={sp} /></>}
          />
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>{t('reconciliation')}</span>
            <Badge variant={reconciled ? 'success' : 'destructive'}>
              {reconciled ? t('reconciled') : t('offBy', { amount: m(cf.reconciliationGap) })}
            </Badge>
          </div>
        </>
      }
    >
      <ReportPaper company={org?.name ?? ''} title={t('title')} periodPhrase={t('dateRange', { from, to })}>
        <Table>
          <TableBody>
          {!hasMovements ? (
            <TableRow>
              <TableCell colSpan={2} className="text-center text-slate-400 italic">
                {t('empty')}
              </TableCell>
            </TableRow>
          ) : (
            SECTION_ORDER.map((section) => {
              const s = cf.sections.find((x) => x.section === section)!
              return (
                <SectionRows
                  key={section}
                  title={sectionLabels[section]}
                  subtotalLabel={t('subtotal', { section: sectionLabels[section].toLowerCase() })}
                  lines={s.lines}
                  subtotal={s.subtotal}
                  m={m}
                  from={from}
                  to={to}
                  dims={dims}
                />
              )
            })
          )}
          {hasMovements ? (
            <>
              <TableRow className={reportSubtotalRowClass}>
                <TableCell className="font-bold">{t('netChange')}</TableCell>
                <TableCell className={cn('text-right font-bold tabular-nums', decimalCmp(cf.netChange, '0') < 0 && 'text-red-600 dark:text-red-400')}>
                  <ReportDrillLink target={{ kind: 'ledger', label: t('netChange'), accountTypes: cf.sections.flatMap((s) => s.lines.map((line) => line.type)), from, to, mode: 'flow', dims, cashOnly: true }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(cf.netChange)}</ReportDrillLink>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="pl-8 text-slate-500 dark:text-slate-400">{t('openingCash')}</TableCell>
                <TableCell className="text-right tabular-nums text-slate-500 dark:text-slate-400"><ReportDrillLink target={{ kind: 'ledger', label: t('openingCash'), accountTypes: ['asset_bank'], to: openingDate, mode: 'balance', dims }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(cf.openingCash)}</ReportDrillLink></TableCell>
              </TableRow>
              <TableRow className={reportTotalRowClass}>
                <TableCell className="font-semibold">{t('closingCash')}</TableCell>
                <TableCell className={cn('text-right font-semibold tabular-nums', decimalCmp(cf.closingCash, '0') < 0 && 'text-red-600 dark:text-red-400')}>
                  <ReportDrillLink target={{ kind: 'ledger', label: t('closingCash'), accountTypes: ['asset_bank'], to, mode: 'balance', dims }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(cf.closingCash)}</ReportDrillLink>
                </TableCell>
              </TableRow>
            </>
          ) : null}
          </TableBody>
        </Table>
      </ReportPaper>
    </ListPageLayout>
  )
}

function SectionRows({
  title,
  subtotalLabel,
  lines,
  subtotal,
  m,
  from,
  to,
  dims,
}: {
  title: string
  subtotalLabel: string
  lines: { type: string; label: string; amount: ExactDecimal }[]
  subtotal: ExactDecimal
  m: (v: ExactDecimal) => string
  from: string
  to: string
  dims: StatementDimFilter
}) {
  return (
    <>
      <TableRow>
        <TableCell
          colSpan={2}
          className="pt-4 pb-1 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-300"
        >
          {title}
        </TableCell>
      </TableRow>
      {lines.length === 0 ? (
        <TableRow>
          <TableCell colSpan={2} className="pl-8 text-slate-300 italic dark:text-slate-600">
            —
          </TableCell>
        </TableRow>
      ) : (
        lines.map((l) => (
          <TableRow key={l.type}>
            <TableCell className="pl-8">{l.label}</TableCell>
            <TableCell className={cn('text-right tabular-nums', decimalCmp(l.amount, '0') < 0 && 'text-red-600 dark:text-red-400')}>
              <ReportDrillLink target={{ kind: 'ledger', label: l.label, accountTypes: [l.type], from, to, mode: 'flow', dims, cashOnly: true }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(l.amount)}</ReportDrillLink>
            </TableCell>
          </TableRow>
        ))
      )}
      <TableRow className={reportSubtotalRowClass}>
        <TableCell className="font-semibold">{subtotalLabel}</TableCell>
        <TableCell className={cn('text-right font-semibold tabular-nums', decimalCmp(subtotal, '0') < 0 && 'text-red-600 dark:text-red-400')}>
          <ReportDrillLink target={{ kind: 'ledger', label: subtotalLabel, accountTypes: lines.map((line) => line.type), from, to, mode: 'flow', dims, cashOnly: true }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(subtotal)}</ReportDrillLink>
        </TableCell>
      </TableRow>
    </>
  )
}
