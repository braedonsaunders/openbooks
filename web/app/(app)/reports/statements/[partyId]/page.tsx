import { getMoneyFormatter } from '@/lib/money-server'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Badge, PageHeader, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../../components/page-layout'
import { DocTypeBadge } from '../../../../../components/doc-type-badge'
import { partnerStatement, type AgingSide } from '../../../../../lib/reports'
import { orgInfo } from '../../../../../lib/data'
import { resolvePeriod } from '../../../../../lib/periods'
import { parseReportQuery, toSearchParams } from '../../../../../lib/report-filters'
import { ReportFilterBar } from '../../ReportFilterBar'
import { ExportMenu } from '../../ExportMenu'
import { TxnLink } from '../../TxnLink'
import { SaveViewButton } from '../../SaveViewButton'
import { requirePermission } from '../../../../../lib/authz'
import { ReportPaper } from '../../ReportPaper'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, reportTotalRowClass } from '../../ReportTable'
import { ReportDrillLink } from '../../ReportDrillLink'
import { decimalCmp, decimalIsZero } from '../../../../../lib/statement-format'

export const dynamic = 'force-dynamic'

const BUCKETS = ['current', 'b1', 'b2', 'b3', 'b4'] as const

export default async function PartnerStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ partyId: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('reports')
  const tc = await getTranslations('common')
  const authz = await requirePermission('reports.read')
  const { partyId } = await params
  const sp = await searchParams
  const side: AgingSide = sp.side === 'ap' ? 'ap' : 'ar'
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const [st, org] = await Promise.all([
    partnerStatement(partyId, authz.user.orgId, { from: period.from, to: period.to, side }),
    orgInfo(),
  ])
  const m = (v: string) => money(v, { currency: org?.base_currency })
  const keep = toSearchParams(q).toString()
  const accountTypes = [side === 'ap' ? 'liability_payable' : 'asset_receivable']
  const openingTo = new Date(`${period.from}T00:00:00Z`)
  openingTo.setUTCDate(openingTo.getUTCDate() - 1)
  const openingDate = openingTo.toISOString().slice(0, 10)

  const bucketLabels: Record<(typeof BUCKETS)[number], string> = {
    current: t('aging.buckets.current'),
    b1: t('aging.buckets.b1'),
    b2: t('aging.buckets.b2'),
    b3: t('aging.buckets.b3'),
    b4: t('aging.buckets.b4'),
  }

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={st.party.name ?? t('statements.title')}
            back={{ href: '/reports/registers', label: t('registers.arTitle') }}
          />
          <ReportFilterBar
            controls={{ period: true }}
            leading={
              <>
                <Link href={`/reports/statements/${partyId}?side=ar&${keep}`}>
                  <Badge variant={side === 'ar' ? 'default' : 'outline'}>{t('registers.receivables')}</Badge>
                </Link>
                <Link href={`/reports/statements/${partyId}?side=ap&${keep}`}>
                  <Badge variant={side === 'ap' ? 'default' : 'outline'}>{t('registers.payables')}</Badge>
                </Link>
                <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
              </>
            }
            actions={<><SaveViewButton /><ExportMenu kind="partner-statement" params={{ ...sp, party: partyId, side }} /></>}
          />
        </>
      }
    >
      <ReportPaper
        company={org?.name ?? ''}
        title={st.party.name ?? t('statements.title')}
        periodPhrase={t('pnl.dateRange', { from: period.from, to: period.to })}
        wide
      >
        <div className="mb-6 grid grid-flow-col auto-cols-fr divide-x divide-slate-200 border-y border-slate-200 py-3 dark:divide-slate-700 dark:border-slate-700">
          {BUCKETS.map((b) => (
            <div key={b} className="min-w-0 px-2 text-center">
              <div className="truncate text-xs text-slate-500 dark:text-slate-400">{bucketLabels[b]}</div>
              <div className="truncate tabular-nums"><ReportDrillLink target={{ kind: 'aging', label: `${st.party.name ?? t('statements.title')} · ${bucketLabels[b]}`, side, asOf: period.to, partyId, bucket: b }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(st.aging[b])}</ReportDrillLink></div>
            </div>
          ))}
          <div className="min-w-0 px-2 text-center font-semibold">
            <div className="truncate text-xs text-slate-500 dark:text-slate-400">{t('aging.columns.total')}</div>
            <div className="truncate tabular-nums"><ReportDrillLink target={{ kind: 'aging', label: st.party.name ?? t('statements.title'), side, asOf: period.to, partyId }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(st.aging.total)}</ReportDrillLink></div>
          </div>
        </div>
        <Table>
          <TableHeader>
          <TableRow>
            <TableHead className="w-28">{t('generalLedger.columns.date')}</TableHead>
            <TableHead className="w-24">{t('generalLedger.columns.entry')}</TableHead>
            <TableHead>{tc('labels.memo')}</TableHead>
            <TableHead className="text-right">{t('trialBalance.columns.debits')}</TableHead>
            <TableHead className="text-right">{t('trialBalance.columns.credits')}</TableHead>
            <TableHead className="text-right">{tc('labels.balance')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell colSpan={5} className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {t('statements.opening')}
            </TableCell>
            <TableCell className="text-right font-medium tabular-nums"><ReportDrillLink target={{ kind: 'ledger', label: t('statements.opening'), accountTypes, partyIds: [partyId], to: openingDate, mode: 'balance' }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(st.opening)}</ReportDrillLink></TableCell>
          </TableRow>
          {st.lines.map((l, i) => (
            <TableRow key={`${l.entryId}-${i}`}>
              <TableCell className="tabular-nums">{l.date}</TableCell>
              <TableCell>
                <span className="flex items-center gap-1.5">
                  <TxnLink entryId={l.entryId} docKind={l.docKind} docId={l.docId} className="font-mono text-xs hover:text-teal-700 dark:hover:text-teal-300">
                    {l.entryNumber}
                  </TxnLink>
                  {l.docKind && <DocTypeBadge kind={l.docKind} icon={false} />}
                </span>
              </TableCell>
              <TableCell className="text-slate-600 dark:text-slate-300">{l.memo}</TableCell>
              <TableCell className="text-right tabular-nums"><TxnLink entryId={l.entryId} docKind={l.docKind} docId={l.docId} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{!decimalIsZero(l.debit) ? m(l.debit) : ''}</TxnLink></TableCell>
              <TableCell className="text-right tabular-nums"><TxnLink entryId={l.entryId} docKind={l.docKind} docId={l.docId} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{!decimalIsZero(l.credit) ? m(l.credit) : ''}</TxnLink></TableCell>
              <TableCell className={cn('text-right tabular-nums', decimalCmp(l.balance, '0') < 0 && 'text-red-600 dark:text-red-400')}>
                <TxnLink entryId={l.entryId} docKind={l.docKind} docId={l.docId} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(l.balance)}</TxnLink>
              </TableCell>
            </TableRow>
          ))}
          <TableRow className={reportTotalRowClass}>
            <TableCell colSpan={5} className="text-xs font-semibold">
              {t('statements.closing')}
            </TableCell>
            <TableCell className={cn('text-right font-semibold tabular-nums', decimalCmp(st.closing, '0') < 0 && 'text-red-600 dark:text-red-400')}>
              <ReportDrillLink target={{ kind: 'ledger', label: t('statements.closing'), accountTypes, partyIds: [partyId], to: period.to, mode: 'balance' }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(st.closing)}</ReportDrillLink>
            </TableCell>
          </TableRow>
          </TableBody>
        </Table>
      </ReportPaper>
    </ListPageLayout>
  )
}
