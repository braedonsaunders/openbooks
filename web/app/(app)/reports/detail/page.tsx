import { getTranslations } from 'next-intl/server'
import { PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { Pagination } from '../../../../components/pagination'
import { DocTypeBadge } from '../../../../components/doc-type-badge'
import { transactionDetail } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { parseDrillQuery } from '../../../../lib/report-filters'
import { reportSubsidiaryView } from '../../../../lib/consolidation'
import { currencySymbol } from '../../../../lib/statement-format'
import { money } from '../../../../lib/format'
import { TxnLink } from '../TxnLink'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 100

export default async function DrillDetail({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('reports')
  const tc = await getTranslations('common')
  const sp = await searchParams
  const q = parseDrillQuery(sp)
  const page = Math.max(1, Number(sp.page ?? '1') || 1)

  // Drill-through re-resolves the report's subsidiary context; detail amounts
  // stay in each entity's functional currency (translation is statement-only).
  const subView = await reportSubsidiaryView(q.subsidiaryId, q.to)
  const [result, org] = await Promise.all([
    transactionDetail({
      accountIds: q.accountIds.length ? q.accountIds : undefined,
      accountTypes: q.accountTypes.length ? q.accountTypes : undefined,
      from: q.from,
      to: q.to,
      mode: q.mode,
      dims: { ...q.dims, subsidiaryIds: subView.subsidiary?.ids },
      basis: q.basis,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    orgInfo(),
  ])
  const sym = currencySymbol(org?.base_currency)
  const m = (v: number) => money(v, sym)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={q.label || t('detail.title')}
            back={{ href: q.back, label: q.backLabel ? t('detail.backTo', { report: q.backLabel }) : t('hub.title') }}
          />
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
            <span className="flex items-baseline gap-1.5 font-semibold">
              <span className="text-xs text-slate-500 dark:text-slate-400">{t('detail.netTotal')}</span>
              <span className={cn('tabular-nums', result.net < 0 && 'text-red-600 dark:text-red-400')}>{m(result.net)}</span>
            </span>
            <span className="flex items-baseline gap-1.5 text-slate-500 dark:text-slate-400">
              <span className="text-xs">{t('trialBalance.columns.debits')}</span>
              <span className="tabular-nums">{m(result.totalDebit)}</span>
            </span>
            <span className="flex items-baseline gap-1.5 text-slate-500 dark:text-slate-400">
              <span className="text-xs">{t('trialBalance.columns.credits')}</span>
              <span className="tabular-nums">{m(result.totalCredit)}</span>
            </span>
          </div>
        </>
      }
    >
      {result.count === 0 ? (
        <p className="py-8 text-center text-slate-400 italic">{t('detail.empty')}</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">{t('generalLedger.columns.date')}</TableHead>
                <TableHead className="w-40">{t('generalLedger.columns.entry')}</TableHead>
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
                    <span className="flex items-center gap-1.5">
                      <TxnLink
                        entryId={l.entryId}
                        docKind={l.docKind}
                        docId={l.docId}
                        className="font-mono text-xs hover:text-teal-700 dark:hover:text-teal-300"
                      >
                        {l.entryNumber}
                      </TxnLink>
                      {l.docKind && <DocTypeBadge kind={l.docKind} icon={false} />}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">{l.accountNumber}</span>
                    {l.accountName}
                  </TableCell>
                  <TableCell className="text-slate-600 dark:text-slate-300">{[l.party, l.memo].filter(Boolean).join(' · ')}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.amount > 0 ? m(l.amount) : ''}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.amount < 0 ? m(-l.amount) : ''}</TableCell>
                </TableRow>
              ))}
              <TableRow className="border-t border-slate-300 dark:border-slate-600">
                <TableCell colSpan={4} className="font-semibold">
                  {t('trialBalance.totals')}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{m(result.totalDebit)}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{m(result.totalCredit)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <Pagination basePath="/reports/detail" currentParams={sp} total={result.count} page={page} perPage={PAGE_SIZE} />
        </>
      )}
    </ListPageLayout>
  )
}
