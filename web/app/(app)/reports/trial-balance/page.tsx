import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { dimensionOptions, trialBalance } from '../../../../lib/reports'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { money } from '../../../../lib/format'
import { ReportFilterBar } from '../ReportFilterBar'
import { StatementExport } from '../StatementExport'
import { SaveViewButton } from '../SaveViewButton'

export const dynamic = 'force-dynamic'

export default async function TrialBalance({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('reports')
  const tc = await getTranslations('common')
  const sp = await searchParams
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const date = period.to
  const dims = { departmentId: q.dims.departmentId, projectId: q.dims.projectId }
  const [rows, opts] = await Promise.all([trialBalance(date, dims), dimensionOptions()])
  const totalDebits = rows.reduce((a, r) => a + Number(r.debits), 0)
  const totalCredits = rows.reduce((a, r) => a + Number(r.credits), 0)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('trialBalance.title')}
            description={t('trialBalance.description', { date, count: rows.length })}
            back={{ href: '/reports', label: t('hub.title') }}
            actions={<><SaveViewButton /><StatementExport kind="trial-balance" params={sp} /></>}
          />
          <ReportFilterBar controls={{ period: true, asOf: true, dimensions: true }} dimensions={opts} />
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{tc('labels.account')}</TableHead>
            <TableHead className="text-right">{t('trialBalance.columns.debits')}</TableHead>
            <TableHead className="text-right">{t('trialBalance.columns.credits')}</TableHead>
            <TableHead className="text-right">{tc('labels.balance')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Link href={`/accounts/${r.id}`} className="hover:text-teal-700 dark:hover:text-teal-300">
                  <span className="mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">{r.number}</span>
                  {r.name}
                </Link>
              </TableCell>
              <TableCell className="text-right tabular-nums">{money(r.debits)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(r.credits)}</TableCell>
              <TableCell className={cn('text-right tabular-nums', Number(r.balance) < 0 && 'text-red-600 dark:text-red-400')}>
                {money(r.balance)}
              </TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="font-bold">{t('trialBalance.totals')}</TableCell>
            <TableCell className="text-right font-bold tabular-nums">{money(totalDebits)}</TableCell>
            <TableCell className="text-right font-bold tabular-nums">{money(totalCredits)}</TableCell>
            <TableCell
              className={cn(
                'text-right font-bold tabular-nums',
                Math.abs(totalDebits - totalCredits) >= 0.01 && 'text-red-600 dark:text-red-400',
              )}
            >
              {money(totalDebits - totalCredits)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </ListPageLayout>
  )
}
