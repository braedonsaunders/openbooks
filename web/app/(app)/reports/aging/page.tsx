import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { agingByParty, agingDetail, dimensionOptions, type AgingSide } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { currencySymbol } from '../../../../lib/statement-format'
import { money } from '../../../../lib/format'
import { ReportFilterBar } from '../ReportFilterBar'
import { ExportMenu } from '../ExportMenu'
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
  // Aging is inherently "as of a date" — default to TODAY, not the fiscal year.
  const period = await resolvePeriod(sp.period ?? 'today', { customFrom: q.from, customTo: q.to })
  const asOf = period.to
  const dims = { departmentId: q.dims.departmentId, projectId: q.dims.projectId }
  const [summary, detailResult, opts, org] = await Promise.all([
    agingByParty(side, asOf, dims),
    detail ? agingDetail(side, asOf, dims) : null,
    dimensionOptions(),
    orgInfo(),
  ])
  const sym = currencySymbol(org?.base_currency)
  const m = (v: number) => money(v, sym)

  const title = `${side === 'ap' ? t('payablesTitle') : t('receivablesTitle')} · ${detail ? t('detail') : t('summary')}`

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
          <PageHeader title={title} back={{ href: '/reports', label: tr('hub.title') }} />
          <ReportFilterBar
            controls={{ period: true, asOf: true, dimensions: true }}
            dimensions={opts}
            defaultPeriod="today"
            actions={<><SaveViewButton /><ExportMenu kind="aging" params={sp} /></>}
          />
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
                  <TableCell className="text-right font-medium tabular-nums">{m(r.open)}</TableCell>
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
                      {r[b] !== 0 ? m(r[b]) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-semibold tabular-nums">{m(r.total)}</TableCell>
                </TableRow>
              ))
            )}
            {summary.rows.length > 0 ? (
              <TableRow>
                <TableCell className="font-bold">{tr('trialBalance.totals')}</TableCell>
                {BUCKETS.map((b) => (
                  <TableCell key={b} className="text-right font-bold tabular-nums">{m(summary.totals[b])}</TableCell>
                ))}
                <TableCell className="text-right font-bold tabular-nums">{m(summary.totals.total)}</TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      )}
    </ListPageLayout>
  )
}
