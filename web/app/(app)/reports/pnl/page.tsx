import Link from 'next/link'
import { Badge, Card, CardContent, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { currentFiscalYearEnd, dimensionOptions, fiscalYearRange, profitAndLoss } from '../../../../lib/reports'
import { layoutsFor, renderLayout, type RenderedLine } from '../../../../lib/layouts'
import { money } from '../../../../lib/format'
import { StatementTable } from '../StatementTable'
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
  const sp = await searchParams
  const fyNow = currentFiscalYearEnd()
  const def = fiscalYearRange(fyNow)
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
            title="Profit & Loss"
            description={`${from} → ${to}`}
            back={{ href: '/reports', label: 'Reports' }}
            actions={<SaveViewButton />}
          />
          <div className="flex flex-wrap items-center gap-2">
            {[fyNow, fyNow - 1, fyNow - 2].map((y) => {
              const r = fiscalYearRange(y)
              const active = from === r.from && to === r.to
              return (
                <Link key={y} href={`/reports/pnl?from=${r.from}&to=${r.to}&${keepDims}`}>
                  <Badge variant={active ? 'default' : 'outline'}>{r.label}</Badge>
                </Link>
              )
            })}
            <Link href={`/reports/pnl?from=${from}&to=${to}&${keepDims}${comparing ? '' : '&compare=1'}`}>
              <Badge variant={comparing ? 'default' : 'outline'}>vs prior year</Badge>
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
            <Stat label="Revenue" value={pl.revenue} />
            <Stat label="Gross profit" value={pl.grossProfit} />
            <Stat label="Net income" value={pl.netIncome} tone={pl.netIncome >= 0 ? 'good' : 'bad'} />
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
            { title: 'Revenue', types: ['income', 'income_other'], rows: pl.items, total: pl.revenue },
            { title: 'Cost of Goods Sold', types: ['cogs'], rows: pl.items, total: pl.cogs },
            { title: 'Expenses', types: ['expense', 'expense_other', 'expense_deferred'], rows: pl.items, total: pl.expenses },
          ]}
          grandTotal={{ label: 'Net income', value: pl.netIncome }}
        />
      )}
    </ListPageLayout>
  )
}

function LayoutTable({ lines }: { lines: RenderedLine[] }) {
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
                  {l.label}
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
              <TableCell className={l.emphasis ? 'font-bold' : 'font-semibold'}>{l.label}</TableCell>
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

function ComparativeTable({
  current,
  prior,
}: {
  current: Awaited<ReturnType<typeof profitAndLoss>>
  prior: Awaited<ReturnType<typeof profitAndLoss>>
}) {
  const priorById = new Map(prior.items.map((r) => [r.id, r.balance]))
  const seen = new Set(current.items.map((r) => r.id))
  const rows = [
    ...current.items.map((r) => ({ ...r, prior: priorById.get(r.id) ?? 0 })),
    ...prior.items.filter((r) => !seen.has(r.id)).map((r) => ({ ...r, balance: 0, prior: r.balance })),
  ]
  const totals = [
    { label: 'Total Revenue', cur: current.revenue, pri: prior.revenue },
    { label: 'Gross profit', cur: current.grossProfit, pri: prior.grossProfit },
    { label: 'Net income', cur: current.netIncome, pri: prior.netIncome },
  ]
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Account</TableHead>
          <TableHead className="text-right">Current</TableHead>
          <TableHead className="text-right">Prior year</TableHead>
          <TableHead className="text-right">Δ</TableHead>
          <TableHead className="text-right">Δ%</TableHead>
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
        {totals.map((t) => (
          <TableRow key={t.label}>
            <TableCell className="font-bold">{t.label}</TableCell>
            <TableCell className="text-right font-bold tabular-nums">{money(t.cur)}</TableCell>
            <TableCell className="text-right font-bold tabular-nums">{money(t.pri)}</TableCell>
            <TableCell className={cn('text-right font-bold tabular-nums', t.cur - t.pri < 0 && 'text-red-600 dark:text-red-400')}>
              {money(t.cur - t.pri)}
            </TableCell>
            <TableCell className="text-right font-bold tabular-nums">
              {t.pri !== 0 ? `${(((t.cur - t.pri) / Math.abs(t.pri)) * 100).toFixed(1)}%` : ''}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
