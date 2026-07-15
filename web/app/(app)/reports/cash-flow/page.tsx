import { getTranslations } from 'next-intl/server'
import { Badge, PageHeader, Table, TableBody, TableCell, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { cashFlow, dimensionOptions, type CashFlowSection } from '../../../../lib/reports'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { money } from '../../../../lib/format'
import { ReportFilterBar } from '../ReportFilterBar'
import { StatementExport } from '../StatementExport'
import { SaveViewButton } from '../SaveViewButton'

export const dynamic = 'force-dynamic'

const SECTION_ORDER: CashFlowSection[] = ['operating', 'investing', 'financing']

export default async function CashFlow({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('reports.cashFlow')
  const tr = await getTranslations('reports')
  const sp = await searchParams
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const from = period.from
  const to = period.to
  const dims = { departmentId: q.dims.departmentId, projectId: q.dims.projectId }
  const [cf, opts] = await Promise.all([cashFlow(from, to, dims), dimensionOptions()])

  const sectionLabels: Record<CashFlowSection, string> = {
    operating: t('sections.operating'),
    investing: t('sections.investing'),
    financing: t('sections.financing'),
  }
  const reconciled = Math.abs(cf.reconciliationGap) < 0.01
  const hasMovements = cf.sections.some((s) => s.lines.length > 0)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('title')}
            description={t('dateRange', { from, to })}
            back={{ href: '/reports', label: tr('hub.title') }}
            actions={<><SaveViewButton /><StatementExport kind="cash-flow" params={sp} /></>}
          />
          <ReportFilterBar controls={{ period: true, dimensions: true }} dimensions={opts} />
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>{t('reconciliation')}</span>
            <Badge variant={reconciled ? 'success' : 'destructive'}>
              {reconciled ? t('reconciled') : t('offBy', { amount: money(cf.reconciliationGap) })}
            </Badge>
          </div>
        </>
      }
    >
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
                />
              )
            })
          )}
          {hasMovements ? (
            <>
              <TableRow>
                <TableCell className="font-bold">{t('netChange')}</TableCell>
                <TableCell className={cn('text-right font-bold tabular-nums', cf.netChange < 0 && 'text-red-600 dark:text-red-400')}>
                  {money(cf.netChange)}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="pl-8 text-slate-500 dark:text-slate-400">{t('openingCash')}</TableCell>
                <TableCell className="text-right tabular-nums text-slate-500 dark:text-slate-400">{money(cf.openingCash)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-semibold">{t('closingCash')}</TableCell>
                <TableCell className={cn('text-right font-semibold tabular-nums', cf.closingCash < 0 && 'text-red-600 dark:text-red-400')}>
                  {money(cf.closingCash)}
                </TableCell>
              </TableRow>
            </>
          ) : null}
        </TableBody>
      </Table>
    </ListPageLayout>
  )
}

function SectionRows({
  title,
  subtotalLabel,
  lines,
  subtotal,
}: {
  title: string
  subtotalLabel: string
  lines: { type: string; label: string; amount: number }[]
  subtotal: number
}) {
  return (
    <>
      <TableRow>
        <TableCell
          colSpan={2}
          className="bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:bg-slate-900 dark:text-slate-300"
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
            <TableCell className={cn('text-right tabular-nums', l.amount < 0 && 'text-red-600 dark:text-red-400')}>
              {money(l.amount)}
            </TableCell>
          </TableRow>
        ))
      )}
      <TableRow>
        <TableCell className="font-semibold">{subtotalLabel}</TableCell>
        <TableCell className={cn('text-right font-semibold tabular-nums', subtotal < 0 && 'text-red-600 dark:text-red-400')}>
          {money(subtotal)}
        </TableCell>
      </TableRow>
    </>
  )
}
