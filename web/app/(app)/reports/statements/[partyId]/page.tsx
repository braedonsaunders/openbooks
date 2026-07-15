import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Badge, Card, CardContent, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../../components/page-layout'
import { partnerStatement, type AgingSide } from '../../../../../lib/reports'
import { resolvePeriod } from '../../../../../lib/periods'
import { parseReportQuery, toSearchParams } from '../../../../../lib/report-filters'
import { money } from '../../../../../lib/format'
import { ReportFilterBar } from '../../ReportFilterBar'
import { SaveViewButton } from '../../SaveViewButton'
import { StatementExport } from '../../StatementExport'

export const dynamic = 'force-dynamic'

const BUCKETS = ['current', 'b1', 'b2', 'b3', 'b4'] as const

export default async function PartnerStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ partyId: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('reports')
  const tc = await getTranslations('common')
  const { partyId } = await params
  const sp = await searchParams
  const side: AgingSide = sp.side === 'ap' ? 'ap' : 'ar'
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const st = await partnerStatement(partyId, { from: period.from, to: period.to, side })
  const keep = toSearchParams(q).toString()

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
            description={`${t('statements.title')} · ${t('pnl.dateRange', { from: period.from, to: period.to })}`}
            back={{ href: '/reports/registers', label: t('registers.arTitle') }}
            actions={<><SaveViewButton /><StatementExport kind="partner-statement" params={{ ...sp, party: partyId, side }} /></>}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/reports/statements/${partyId}?side=ar&${keep}`}>
              <Badge variant={side === 'ar' ? 'default' : 'outline'}>{t('registers.receivables')}</Badge>
            </Link>
            <Link href={`/reports/statements/${partyId}?side=ap&${keep}`}>
              <Badge variant={side === 'ap' ? 'default' : 'outline'}>{t('registers.payables')}</Badge>
            </Link>
            <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
            <ReportFilterBar controls={{ period: true }} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {BUCKETS.map((b) => (
              <Card key={b}>
                <CardContent className="p-4">
                  <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{bucketLabels[b]}</span>
                  <span className="block text-lg font-semibold tabular-nums">{money(st.aging[b])}</span>
                </CardContent>
              </Card>
            ))}
            <Card>
              <CardContent className="p-4">
                <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('aging.columns.total')}</span>
                <span className="block text-lg font-semibold tabular-nums">{money(st.aging.total)}</span>
              </CardContent>
            </Card>
          </div>
        </>
      }
    >
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
            <TableCell className="text-right font-medium tabular-nums">{money(st.opening)}</TableCell>
          </TableRow>
          {st.lines.map((l, i) => (
            <TableRow key={`${l.entryId}-${i}`}>
              <TableCell className="tabular-nums">{l.date}</TableCell>
              <TableCell>
                <Link href={`/journal/${l.entryId}`} className="font-mono text-xs hover:text-teal-700 dark:hover:text-teal-300">
                  {l.entryNumber}
                </Link>
              </TableCell>
              <TableCell className="text-slate-600 dark:text-slate-300">{l.memo}</TableCell>
              <TableCell className="text-right tabular-nums">{l.debit ? money(l.debit) : ''}</TableCell>
              <TableCell className="text-right tabular-nums">{l.credit ? money(l.credit) : ''}</TableCell>
              <TableCell className={cn('text-right tabular-nums', l.balance < 0 && 'text-red-600 dark:text-red-400')}>
                {money(l.balance)}
              </TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell colSpan={5} className="text-xs font-semibold">
              {t('statements.closing')}
            </TableCell>
            <TableCell className={cn('text-right font-semibold tabular-nums', st.closing < 0 && 'text-red-600 dark:text-red-400')}>
              {money(st.closing)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </ListPageLayout>
  )
}
