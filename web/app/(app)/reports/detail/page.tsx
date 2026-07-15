import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Card, CardContent, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { transactionDetail } from '../../../../lib/reports'
import { parseDrillQuery } from '../../../../lib/report-filters'
import { money } from '../../../../lib/format'

export const dynamic = 'force-dynamic'

export default async function DrillDetail({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('reports')
  const tc = await getTranslations('common')
  const sp = await searchParams
  const q = parseDrillQuery(sp)

  const result = await transactionDetail({
    accountIds: q.accountIds.length ? q.accountIds : undefined,
    accountTypes: q.accountTypes.length ? q.accountTypes : undefined,
    from: q.from,
    to: q.to,
    mode: q.mode,
    dims: q.dims,
    basis: q.basis,
  })

  const periodLabel = q.mode === 'balance' ? t('balanceSheet.asOf', { date: q.to }) : t('pnl.dateRange', { from: q.from ?? '', to: q.to })

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={q.label || t('detail.title')}
            description={periodLabel}
            back={{ href: q.back, label: q.backLabel ? t('detail.backTo', { report: q.backLabel }) : t('hub.title') }}
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <Card>
              <CardContent className="p-4">
                <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('detail.netTotal')}</span>
                <span className={cn('block text-xl font-semibold tabular-nums', result.net < 0 && 'text-red-600 dark:text-red-400')}>
                  {money(result.net)}
                </span>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('trialBalance.columns.debits')}</span>
                <span className="block text-xl font-semibold tabular-nums">{money(result.totalDebit)}</span>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('trialBalance.columns.credits')}</span>
                <span className="block text-xl font-semibold tabular-nums">{money(result.totalCredit)}</span>
              </CardContent>
            </Card>
          </div>
          {result.truncated && <p className="text-xs text-amber-600 dark:text-amber-400">{t('detail.truncated')}</p>}
        </>
      }
    >
      {result.lines.length === 0 ? (
        <p className="py-8 text-center text-slate-400 italic">{t('detail.empty')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">{t('generalLedger.columns.date')}</TableHead>
              <TableHead className="w-24">{t('generalLedger.columns.entry')}</TableHead>
              <TableHead>{tc('labels.account')}</TableHead>
              <TableHead>{t('journal.columns.detail')}</TableHead>
              <TableHead className="text-right">{t('trialBalance.columns.debits')}</TableHead>
              <TableHead className="text-right">{t('trialBalance.columns.credits')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.lines.map((l, i) => (
              <TableRow key={`${l.entryId}-${i}`}>
                <TableCell className="tabular-nums">{l.date}</TableCell>
                <TableCell>
                  <Link href={`/journal/${l.entryId}`} className="font-mono text-xs hover:text-teal-700 dark:hover:text-teal-300">
                    {l.entryNumber}
                  </Link>
                </TableCell>
                <TableCell>
                  <span className="mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">{l.accountNumber}</span>
                  {l.accountName}
                </TableCell>
                <TableCell className="text-slate-600 dark:text-slate-300">{[l.party, l.memo].filter(Boolean).join(' · ')}</TableCell>
                <TableCell className="text-right tabular-nums">{l.amount > 0 ? money(l.amount) : ''}</TableCell>
                <TableCell className="text-right tabular-nums">{l.amount < 0 ? money(-l.amount) : ''}</TableCell>
              </TableRow>
            ))}
            <TableRow className="border-t border-slate-300 dark:border-slate-600">
              <TableCell colSpan={4} className="font-semibold">
                {t('trialBalance.totals')}
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums">{money(result.totalDebit)}</TableCell>
              <TableCell className="text-right font-semibold tabular-nums">{money(result.totalCredit)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </ListPageLayout>
  )
}
