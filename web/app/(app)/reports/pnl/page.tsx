import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Badge, Card, CardContent, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { currentFiscalYearEnd, dimensionOptions, fiscalYearRange, profitAndLoss } from '../../../../lib/reports'
import { layoutsFor, renderLayout, type RenderedLine } from '../../../../lib/layouts'
import { money } from '../../../../lib/format'
import { StatementTable } from '../StatementTable'
import { StatementExport } from '../StatementExport'
import { DimensionFilter } from '../DimensionFilter'
import { SaveViewButton } from '../SaveViewButton'

export const dynamic = 'force-dynamic'

function shiftYear(d: string, years: number): string {
  return `${Number(d.slice(0, 4)) + years}${d.slice(4)}`
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
          {label}
        </span>
        <span
          className={cn(
            'block text-xl font-semibold tabular-nums',
            tone === 'good' && 'text-teal-700 dark:text-teal-300',
            tone === 'bad' && 'text-red-600 dark:text-red-400',
          )}
        >
          {money(value)}
        </span>
      </CardContent>
    </Card>
  )
}

export default async function PnL({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; dept?: string; project?: string; compare?: string; layout?: string }>
}) {
  const t = await getTranslations('reports')
  const sp = await searchParams
  const fyNow = await currentFiscalYearEnd()
  // Resolve the three FY presets (current + two prior) once — the range reads
  // the org's configured fiscal-year start month, so presets stay in sync with
  // Company & Accounting settings.
  const fyPresets = await Promise.all([fyNow, fyNow - 1, fyNow - 2].map((y) => fiscalYearRange(y)))
  const def = fyPresets[0]
  const from = sp.from ?? def.from
  const to = sp.to ?? def.to
  const dims = { departmentId: sp.dept || undefined, projectId: sp.project || undefined }
  const comparing = sp.compare === '1'
  const [pl, prior, opts, layouts, laid] = await Promise.all([
    profitAndLoss(from, to, dims),
    comparing ? profitAndLoss(shiftYear(from, -1), shiftYear(to, -1), dims) : null,
    dimensionOptions(),
    layoutsFor('pnl'),
    sp.layout ? renderLayout(sp.layout, from, to, dims) : null,
  ])

  const keepDims = `dept=${sp.dept ?? ''}&project=${sp.project ?? ''}`

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('pnl.title')}
            description={t('pnl.dateRange', { from, to })}
            back={{ href: '/reports', label: t('hub.title') }}
            actions={<><SaveViewButton /><StatementExport kind="pnl" params={{ from, to, dept: sp.dept, project: sp.project }} /></>}
          />
          <div className="flex flex-wrap items-center gap-2">
            {fyPresets.map((r) => {
              const active = from === r.from && to === r.to
              return (
                <Link key={r.label} href={`/reports/pnl?from=${r.from}&to=${r.to}&${keepDims}`}>
                  <Badge variant={active ? 'default' : 'outline'}>{r.label}</Badge>
                </Link>
              )
            })}
            <Link href={`/reports/pnl?from=${from}&to=${to}&${keepDims}${comparing ? '' : '&compare=1'}`}>
              <Badge variant={comparing ? 'default' : 'outline'}>{t('pnl.vsPriorYear')}</Badge>
            </Link>
            {layouts.map((l) => (
              <Link
                key={l.id}
                href={`/reports/pnl?from=${from}&to=${to}&${keepDims}${sp.layout === l.id ? '' : `&layout=${l.id}`}`}
              >
                <Badge variant={sp.layout === l.id ? 'default' : 'outline'}>{l.name}</Badge>
              </Link>
            ))}
            <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
            <DimensionFilter departments={opts.departments} projects={opts.projects} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label={t('pnl.revenue')} value={pl.revenue} />
            <Stat label={t('pnl.grossProfit')} value={pl.grossProfit} />
            <Stat label={t('pnl.netIncome')} value={pl.netIncome} tone={pl.netIncome >= 0 ? 'good' : 'bad'} />
          </div>
        </>
      }
    >
      {laid ? (
        <LayoutTable lines={laid.lines} />
      ) : prior ? (
        <ComparativeTable current={pl} prior={prior} />
      ) : (
        <StatementTable
          sections={[
            { title: t('pnl.revenue'), types: ['income', 'income_other'], rows: pl.items, total: pl.revenue },
            { title: t('pnl.costOfGoodsSold'), types: ['cogs'], rows: pl.items, total: pl.cogs },
            { title: t('pnl.expenses'), types: ['expense', 'expense_other', 'expense_deferred'], rows: pl.items, total: pl.expenses },
          ]}
          grandTotal={{ label: t('pnl.netIncome'), value: pl.netIncome }}
          period={{ from, to }}
        />
      )}
    </ListPageLayout>
  )
}

async function LayoutTable({ lines }: { lines: RenderedLine[] }) {
  const t = await getTranslations('reports')
  // User-authored layout labels (statement_layouts.rows) render verbatim; only
  // code-generated lines (auto totals, the leftover "Other" group) translate.
  const labelFor = (l: RenderedLine): string => {
    if (l.auto === 'other') return t('statement.other')
    if (l.auto === 'otherTotal') return t('statement.otherTotal')
    if (l.auto === 'groupTotal') return t('statement.sectionTotal', { section: l.section ?? l.label })
    return l.label
  }
  return (
    <Table>
      <TableBody>
        {lines.map((l, i) => {
          if (l.kind === 'spacer') {
            return (
              <TableRow key={i}>
                <TableCell colSpan={2} className="h-3 border-none p-0" />
              </TableRow>
            )
          }
          if (l.kind === 'header') {
            return (
              <TableRow key={i}>
                <TableCell
                  colSpan={2}
                  className="bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:bg-slate-900 dark:text-slate-300"
                >
                  {labelFor(l)}
                </TableCell>
              </TableRow>
            )
          }
          if (l.kind === 'account') {
            return (
              <TableRow key={i}>
                <TableCell className="pl-8">
                  <Link href={`/accounts/${l.accountId}`} className="hover:text-teal-700 dark:hover:text-teal-300">
                    <span className="mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">{l.number}</span>
                    {l.label}
                  </Link>
                </TableCell>
                <TableCell className={cn('text-right tabular-nums', (l.amount ?? 0) < 0 && 'text-red-600 dark:text-red-400')}>
                  {money(l.amount ?? 0)}
                </TableCell>
              </TableRow>
            )
          }
          return (
            <TableRow key={i}>
              <TableCell className={l.emphasis ? 'font-bold' : 'font-semibold'}>{labelFor(l)}</TableCell>
              <TableCell
                className={cn(
                  'text-right tabular-nums',
                  l.emphasis ? 'font-bold' : 'font-semibold',
                  (l.amount ?? 0) < 0 && 'text-red-600 dark:text-red-400',
                )}
              >
                {money(l.amount ?? 0)}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

async function ComparativeTable({
  current,
  prior,
}: {
  current: Awaited<ReturnType<typeof profitAndLoss>>
  prior: Awaited<ReturnType<typeof profitAndLoss>>
}) {
  const t = await getTranslations('reports')
  const tc = await getTranslations('common')
  const priorById = new Map(prior.items.map((r) => [r.id, r.balance]))
  const seen = new Set(current.items.map((r) => r.id))
  const rows = [
    ...current.items.map((r) => ({ ...r, prior: priorById.get(r.id) ?? 0 })),
    ...prior.items.filter((r) => !seen.has(r.id)).map((r) => ({ ...r, balance: 0, prior: r.balance })),
  ]
  const totals = [
    { label: t('pnl.totalRevenue'), cur: current.revenue, pri: prior.revenue },
    { label: t('pnl.grossProfit'), cur: current.grossProfit, pri: prior.grossProfit },
    { label: t('pnl.netIncome'), cur: current.netIncome, pri: prior.netIncome },
  ]
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc('labels.account')}</TableHead>
          <TableHead className="text-right">{t('pnl.columns.current')}</TableHead>
          <TableHead className="text-right">{t('pnl.columns.priorYear')}</TableHead>
          <TableHead className="text-right">{t('pnl.columns.delta')}</TableHead>
          <TableHead className="text-right">{t('pnl.columns.deltaPct')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const delta = r.balance - r.prior
          const pct = r.prior !== 0 ? (delta / Math.abs(r.prior)) * 100 : null
          return (
            <TableRow key={r.id}>
              <TableCell className={cn(r.depth === 1 && 'pl-8', r.depth >= 2 && 'pl-12', r.isSummary && 'font-semibold')}>
                <span className="mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">{r.number}</span>
                {r.name}
              </TableCell>
              <TableCell className="text-right tabular-nums">{money(r.balance)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(r.prior)}</TableCell>
              <TableCell className={cn('text-right tabular-nums', delta < 0 && 'text-red-600 dark:text-red-400')}>
                {money(delta)}
              </TableCell>
              <TableCell className={cn('text-right tabular-nums', delta < 0 && 'text-red-600 dark:text-red-400')}>
                {pct === null ? '' : `${pct.toFixed(1)}%`}
              </TableCell>
            </TableRow>
          )
        })}
        {totals.map((row) => (
          <TableRow key={row.label}>
            <TableCell className="font-bold">{row.label}</TableCell>
            <TableCell className="text-right font-bold tabular-nums">{money(row.cur)}</TableCell>
            <TableCell className="text-right font-bold tabular-nums">{money(row.pri)}</TableCell>
            <TableCell className={cn('text-right font-bold tabular-nums', row.cur - row.pri < 0 && 'text-red-600 dark:text-red-400')}>
              {money(row.cur - row.pri)}
            </TableCell>
            <TableCell className="text-right font-bold tabular-nums">
              {row.pri !== 0 ? `${(((row.cur - row.pri) / Math.abs(row.pri)) * 100).toFixed(1)}%` : ''}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
