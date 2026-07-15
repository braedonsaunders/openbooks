import { getTranslations } from 'next-intl/server'
import { PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { dimensionOptions, journalReport } from '../../../../lib/reports'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { money } from '../../../../lib/format'
import { TxnLink } from '../TxnLink'
import { ReportFilterBar } from '../ReportFilterBar'
import { SaveViewButton } from '../SaveViewButton'
import { StatementExport } from '../StatementExport'

export const dynamic = 'force-dynamic'

export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('reports')
  const tc = await getTranslations('common')
  const sp = await searchParams
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const dims = { departmentId: q.dims.departmentId, projectId: q.dims.projectId }
  const [journal, opts] = await Promise.all([journalReport(period.from, period.to, { dims }), dimensionOptions()])

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('journal.title')}
            description={t('pnl.dateRange', { from: period.from, to: period.to })}
            back={{ href: '/reports', label: t('hub.title') }}
            actions={<><SaveViewButton /><StatementExport kind="journal" params={sp} /></>}
          />
          <ReportFilterBar controls={{ period: true, dimensions: true }} dimensions={opts} />
          {journal.truncated && <p className="text-xs text-amber-600 dark:text-amber-400">{t('journal.truncated')}</p>}
        </>
      }
    >
      {journal.entries.length === 0 ? (
        <p className="py-8 text-center text-slate-400 italic">{t('journal.empty')}</p>
      ) : (
        <div className="space-y-6">
          {journal.entries.map((e) => (
            <div key={e.id}>
              <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
                <TxnLink entryId={e.id} className="font-mono font-semibold hover:text-teal-700 dark:hover:text-teal-300">
                  {e.entryNumber}
                </TxnLink>
                <span className="tabular-nums text-slate-500 dark:text-slate-400">{e.date}</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {t.has(`journal.origins.${e.origin}`) ? t(`journal.origins.${e.origin}`) : e.origin}
                </span>
                {e.memo && <span className="text-slate-500 dark:text-slate-400">{e.memo}</span>}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tc('labels.account')}</TableHead>
                    <TableHead>{t('journal.columns.detail')}</TableHead>
                    <TableHead className="text-right">{t('trialBalance.columns.debits')}</TableHead>
                    <TableHead className="text-right">{t('trialBalance.columns.credits')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {e.lines.map((l, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <span className="mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">{l.accountNumber}</span>
                        {l.accountName}
                      </TableCell>
                      <TableCell className="text-slate-600 dark:text-slate-300">
                        {[l.party, l.memo].filter(Boolean).join(' · ')}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{l.debit ? money(l.debit) : ''}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.credit ? money(l.credit) : ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))}
        </div>
      )}
    </ListPageLayout>
  )
}
