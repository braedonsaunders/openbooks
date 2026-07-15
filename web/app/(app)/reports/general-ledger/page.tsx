import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { dimensionOptions, generalLedger } from '../../../../lib/reports'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { money } from '../../../../lib/format'
import { ReportFilterBar } from '../ReportFilterBar'
import { TxnLink } from '../TxnLink'
import { SaveViewButton } from '../SaveViewButton'

export const dynamic = 'force-dynamic'

export default async function GeneralLedgerPage({
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
  const [gl, opts] = await Promise.all([
    generalLedger(period.from, period.to, { accountId: sp.account, dims }),
    dimensionOptions(),
  ])

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('generalLedger.title')}
            description={t('pnl.dateRange', { from: period.from, to: period.to })}
            back={{ href: '/reports', label: t('hub.title') }}
            actions={<SaveViewButton />}
          />
          <ReportFilterBar controls={{ period: true, dimensions: true }} dimensions={opts} />
          {gl.truncated && <p className="text-xs text-amber-600 dark:text-amber-400">{t('generalLedger.truncated')}</p>}
        </>
      }
    >
      {gl.accounts.length === 0 ? (
        <p className="py-8 text-center text-slate-400 italic">{t('generalLedger.empty')}</p>
      ) : (
        <div className="space-y-8">
          {gl.accounts.map((a) => (
            <div key={a.id}>
              <h3 className="mb-1 flex items-baseline gap-2 text-sm font-semibold">
                <Link href={`/accounts/${a.id}`} className="hover:text-teal-700 dark:hover:text-teal-300">
                  <span className="mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">{a.number}</span>
                  {a.name}
                </Link>
              </h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-28">{t('generalLedger.columns.date')}</TableHead>
                    <TableHead className="w-24">{t('generalLedger.columns.entry')}</TableHead>
                    <TableHead>{t('generalLedger.columns.detail')}</TableHead>
                    <TableHead className="text-right">{t('trialBalance.columns.debits')}</TableHead>
                    <TableHead className="text-right">{t('trialBalance.columns.credits')}</TableHead>
                    <TableHead className="text-right">{tc('labels.balance')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell colSpan={5} className="text-xs font-medium text-slate-500 dark:text-slate-400">
                      {t('generalLedger.opening')}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{money(a.opening)}</TableCell>
                  </TableRow>
                  {a.lines.map((l, i) => (
                    <TableRow key={`${l.entryId}-${i}`}>
                      <TableCell className="tabular-nums">{l.date}</TableCell>
                      <TableCell>
                        <TxnLink entryId={l.entryId} className="font-mono text-xs hover:text-teal-700 dark:hover:text-teal-300">
                          {l.entryNumber}
                        </TxnLink>
                      </TableCell>
                      <TableCell className="text-slate-600 dark:text-slate-300">
                        {[l.party, l.memo].filter(Boolean).join(' · ')}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{l.debit ? money(l.debit) : ''}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.credit ? money(l.credit) : ''}</TableCell>
                      <TableCell className={cn('text-right tabular-nums', l.balance < 0 && 'text-red-600 dark:text-red-400')}>
                        {money(l.balance)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell colSpan={5} className="text-xs font-semibold">
                      {t('generalLedger.closing')}
                    </TableCell>
                    <TableCell className={cn('text-right font-semibold tabular-nums', a.closing < 0 && 'text-red-600 dark:text-red-400')}>
                      {money(a.closing)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          ))}
        </div>
      )}
    </ListPageLayout>
  )
}
