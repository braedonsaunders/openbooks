import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Badge, Card, CardContent, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { agingByParty, agingDetail, dimensionOptions, type AgingSide } from '../../../../lib/reports'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery, toSearchParams } from '../../../../lib/report-filters'
import { money } from '../../../../lib/format'
import { ReportFilterBar } from '../ReportFilterBar'
import { StatementExport } from '../StatementExport'
import { SaveViewButton } from '../SaveViewButton'

export const dynamic = 'force-dynamic'

const BUCKETS = ['current', 'b1', 'b2', 'b3', 'b4'] as const

export default async function Aging({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const t = await getTranslations('reports.aging')
  const tr = await getTranslations('reports')
  const tc = await getTranslations('common')
  const sp = await searchParams
  const side: AgingSide = sp.side === 'ap' ? 'ap' : 'ar'
  const detail = sp.view === 'detail'
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const asOf = period.to
  const dims = { departmentId: q.dims.departmentId, projectId: q.dims.projectId }
  const [summary, detailResult, opts] = await Promise.all([
    agingByParty(side, asOf, dims),
    detail ? agingDetail(side, asOf, dims) : null,
    dimensionOptions(),
  ])
  const totals = detailResult ? detailResult.totals : summary.totals
  const keep = toSearchParams(q).toString()

  const bucketLabels: Record<(typeof BUCKETS)[number], string> = {
    current: t('buckets.current'),
    b1: t('buckets.b1'),
    b2: t('buckets.b2'),
    b3: t('buckets.b3'),
    b4: t('buckets.b4'),
  }

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={side === 'ap' ? t('payablesTitle') : t('receivablesTitle')}
            description={t('asOf', { date: asOf })}
            back={{ href: '/reports', label: tr('hub.title') }}
            actions={<><SaveViewButton /><StatementExport kind="aging" params={sp} /></>}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/reports/aging?side=ar&${keep}${detail ? '&view=detail' : ''}`}>
              <Badge variant={side === 'ar' ? 'default' : 'outline'}>{t('receivables')}</Badge>
            </Link>
            <Link href={`/reports/aging?side=ap&${keep}${detail ? '&view=detail' : ''}`}>
              <Badge variant={side === 'ap' ? 'default' : 'outline'}>{t('payables')}</Badge>
            </Link>
            <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
            <Link href={`/reports/aging?side=${side}&${keep}`}>
              <Badge variant={!detail ? 'default' : 'outline'}>{t('summary')}</Badge>
            </Link>
            <Link href={`/reports/aging?side=${side}&${keep}&view=detail`}>
              <Badge variant={detail ? 'default' : 'outline'}>{t('detail')}</Badge>
            </Link>
            <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
            <ReportFilterBar controls={{ period: true, asOf: true, dimensions: true }} dimensions={opts} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Card>
              <CardContent className="p-4">
                <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('columns.total')}</span>
                <span className="block text-xl font-semibold tabular-nums">{money(totals.total)}</span>
              </CardContent>
            </Card>
            {BUCKETS.map((b) => (
              <Card key={b}>
                <CardContent className="p-4">
                  <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{bucketLabels[b]}</span>
                  <span className="block text-xl font-semibold tabular-nums">{money(totals[b])}</span>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      }
    >
      {detailResult ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tc('labels.party')}</TableHead>
              <TableHead>{tr('generalLedger.columns.entry')}</TableHead>
              <TableHead>{t('columns.due')}</TableHead>
              <TableHead className="text-right">{t('columns.age')}</TableHead>
              <TableHead>{t('columns.bucket')}</TableHead>
              <TableHead className="text-right">{t('columns.total')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detailResult.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-slate-400 italic">{t('empty')}</TableCell>
              </TableRow>
            ) : (
              detailResult.rows.map((r, i) => (
                <TableRow key={`${r.reference ?? 'x'}-${i}`}>
                  <TableCell>
                    {r.partyId ? (
                      <Link href={`/reports/statements/${r.partyId}?side=${side}`} className="hover:text-teal-700 dark:hover:text-teal-300">
                        {r.partyName ?? t('noParty')}
                      </Link>
                    ) : (
                      <span className="text-slate-400 italic">{t('noParty')}</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                  <TableCell className="tabular-nums">{r.dueDate}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.ageDays}</TableCell>
                  <TableCell>{bucketLabels[r.bucket]}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{money(r.open)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tc('labels.party')}</TableHead>
              {BUCKETS.map((b) => (
                <TableHead key={b} className="text-right">{bucketLabels[b]}</TableHead>
              ))}
              <TableHead className="text-right">{t('columns.total')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={BUCKETS.length + 2} className="text-center text-slate-400 italic">{t('empty')}</TableCell>
              </TableRow>
            ) : (
              summary.rows.map((r, i) => (
                <TableRow key={r.partyId ?? `none-${i}`}>
                  <TableCell>
                    {r.partyId ? (
                      <Link href={`/reports/statements/${r.partyId}?side=${side}`} className="hover:text-teal-700 dark:hover:text-teal-300">
                        {r.partyName ?? t('noParty')}
                      </Link>
                    ) : (
                      <span className="text-slate-400 italic">{t('noParty')}</span>
                    )}
                  </TableCell>
                  {BUCKETS.map((b) => (
                    <TableCell key={b} className={cn('text-right tabular-nums', r[b] < 0 && 'text-red-600 dark:text-red-400')}>
                      {r[b] !== 0 ? money(r[b]) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-semibold tabular-nums">{money(r.total)}</TableCell>
                </TableRow>
              ))
            )}
            {summary.rows.length > 0 ? (
              <TableRow>
                <TableCell className="font-bold">{tr('trialBalance.totals')}</TableCell>
                {BUCKETS.map((b) => (
                  <TableCell key={b} className="text-right font-bold tabular-nums">{money(summary.totals[b])}</TableCell>
                ))}
                <TableCell className="text-right font-bold tabular-nums">{money(summary.totals.total)}</TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      )}
    </ListPageLayout>
  )
}
