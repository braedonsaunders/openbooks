import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@openbooks/ui'
import { DetailPageLayout } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { money } from '../../../../lib/format'
import { projectCostSummary } from '../../../../lib/project-costing'
import { loadProject } from '../../../api/projects/_lib'

export const dynamic = 'force-dynamic'

const STATUS_LABELS: Record<string, string> = {
  quoted: 'Quoted',
  awarded: 'Awarded',
  active: 'Active',
  substantially_complete: 'Substantially complete',
  closed: 'Closed',
  cancelled: 'Cancelled',
}
const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'outline' | 'destructive'> = {
  quoted: 'secondary',
  awarded: 'warning',
  active: 'success',
  substantially_complete: 'default',
  closed: 'outline',
  cancelled: 'destructive',
}
const BILLING_LABELS: Record<string, string> = {
  time_and_materials: 'Time & materials',
  fixed_price: 'Fixed price',
  cost_plus: 'Cost plus',
}
const TASK_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  complete: 'Complete',
  cancelled: 'Cancelled',
}

// Document kind → the module drawer that opens it.
const DOC_LINKS: Record<string, { base: string; param: string; label: string }> = {
  bill: { base: '/ap', param: 'bill', label: 'Bill' },
  vendor_bill: { base: '/ap', param: 'bill', label: 'Bill' },
  customer_invoice: { base: '/ar', param: 'invoice', label: 'Invoice' },
  invoice: { base: '/ar', param: 'invoice', label: 'Invoice' },
  expense: { base: '/expenses', param: 'expense', label: 'Expense' },
  expense_report: { base: '/expenses', param: 'expense', label: 'Expense' },
  purchase_order: { base: '/purchase-orders', param: 'order', label: 'Purchase order' },
  sales_order: { base: '/sales-orders', param: 'order', label: 'Sales order' },
  journal: { base: '/journal', param: 'entry', label: 'Journal' },
  journal_entry: { base: '/journal', param: 'entry', label: 'Journal' },
}

function Stat({
  label,
  value,
  tone,
  suffix,
}: {
  label: string
  value: string
  tone?: 'good' | 'bad'
  suffix?: string
}) {
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
          {value}
          {suffix ? <span className="text-sm font-normal text-slate-500 dark:text-slate-400"> {suffix}</span> : null}
        </span>
      </CardContent>
    </Card>
  )
}

export default async function ProjectCockpit({ params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission('projects.read')
  const orgId = authz.user.orgId
  const { id } = await params
  if (!isUuid(id)) notFound()

  const [payload, summary] = await Promise.all([
    loadProject(id, orgId),
    projectCostSummary(orgId, id),
  ])
  if (!payload) notFound()

  const pr = payload.project
  const s = summary

  const projectedCost = s.forecast.projectedCost
  const costBudget = s.budget.cost
  const actualCost = s.actual.cost
  const committedCost = s.committed.cost
  const margin = s.actual.margin

  // Budget-vs-actual bar geometry: track = max(budget, projected) so nothing
  // overflows the track; segments are proportional to that scale.
  const scale = Math.max(costBudget, projectedCost, 1)
  const actualPct = Math.min(100, (actualCost / scale) * 100)
  const committedPct = Math.min(100 - actualPct, (committedCost / scale) * 100)
  const budgetMarkerPct = Math.min(100, (costBudget / scale) * 100)
  const overBudget = projectedCost > costBudget && costBudget > 0

  const fmtDate = (d: unknown) => (d ? String(d) : null)

  return (
    <DetailPageLayout
      header={
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{pr.name as string}</h1>
              {pr.code ? <span className="font-mono text-sm text-slate-500 dark:text-slate-400">{pr.code as string}</span> : null}
              <Badge variant={STATUS_VARIANT[pr.status as string] ?? 'secondary'}>
                {STATUS_LABELS[pr.status as string] ?? (pr.status as string)}
              </Badge>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {[
                payload.customerName,
                pr.billing_method ? BILLING_LABELS[pr.billing_method as string] ?? (pr.billing_method as string) : null,
                fmtDate(pr.starts_on) && fmtDate(pr.ends_on)
                  ? `${fmtDate(pr.starts_on)} → ${fmtDate(pr.ends_on)}`
                  : fmtDate(pr.starts_on)
                    ? `Starts ${fmtDate(pr.starts_on)}`
                    : fmtDate(pr.ends_on)
                      ? `Ends ${fmtDate(pr.ends_on)}`
                      : null,
              ]
                .filter(Boolean)
                .join('  ·  ') || 'Job-costing cockpit'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/projects?project=${id}`}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Edit
            </Link>
            <Link
              href="/projects"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
            >
              All projects
            </Link>
          </div>
        </div>
      }
    >
      <div className="space-y-8">
        {/* -- summary stat cards ---------------------------------------- */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Contract value" value={money(s.budget.contractValue)} />
          <Stat label="Cost budget" value={money(costBudget)} />
          <Stat label="Actual cost" value={money(actualCost)} />
          <Stat label="Committed cost" value={money(committedCost)} />
          <Stat label="Projected cost" value={money(projectedCost)} tone={overBudget ? 'bad' : undefined} />
          <Stat
            label="Remaining budget"
            value={money(s.forecast.remainingBudget)}
            tone={s.forecast.remainingBudget < 0 ? 'bad' : 'good'}
          />
          <Stat label="Actual revenue" value={money(s.actual.revenue)} />
          <Stat label="Margin" value={money(margin)} tone={margin < 0 ? 'bad' : 'good'} />
          <Stat
            label="% spent"
            value={s.forecast.percentSpent == null ? '—' : (s.forecast.percentSpent * 100).toFixed(1)}
            suffix={s.forecast.percentSpent == null ? undefined : '%'}
            tone={overBudget ? 'bad' : undefined}
          />
        </section>

        {/* -- budget vs actual vs committed bar ------------------------- */}
        <section>
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Budget vs actual vs committed</h2>
                <span className={cn('text-sm font-medium tabular-nums', overBudget ? 'text-red-600 dark:text-red-400' : 'text-teal-700 dark:text-teal-300')}>
                  {overBudget
                    ? `${money(projectedCost - costBudget)} over budget`
                    : costBudget > 0
                      ? `${money(costBudget - projectedCost)} under budget`
                      : 'No cost budget set'}
                </span>
              </div>
              <div className="relative h-6 w-full overflow-hidden rounded-md bg-slate-100 dark:bg-slate-800">
                {/* actual */}
                <div
                  className="absolute inset-y-0 left-0 bg-teal-500"
                  style={{ width: `${actualPct}%` }}
                  title={`Actual ${money(actualCost)}`}
                />
                {/* committed, stacked after actual */}
                <div
                  className="absolute inset-y-0 bg-amber-400"
                  style={{ left: `${actualPct}%`, width: `${committedPct}%` }}
                  title={`Committed ${money(committedCost)}`}
                />
                {/* budget marker */}
                {costBudget > 0 ? (
                  <div
                    className="absolute inset-y-0 w-0.5 bg-slate-900 dark:bg-white"
                    style={{ left: `${budgetMarkerPct}%` }}
                    title={`Cost budget ${money(costBudget)}`}
                  />
                ) : null}
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-teal-500" /> Actual {money(actualCost)}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400" /> Committed {money(committedCost)}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-0.5 bg-slate-900 dark:bg-white" /> Cost budget {money(costBudget)}
                </span>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* -- cost by category + by account ----------------------------- */}
        <section className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Cost by category</h2>
            {s.costByCategory.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">No posted costs yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead align="right" className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.costByCategory.map((c) => (
                    <TableRow key={c.category}>
                      <TableCell>{c.category}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(c.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Cost by account</h2>
            {s.costByAccount.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">No posted costs yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead align="right" className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.costByAccount.map((a) => (
                    <TableRow key={a.accountId}>
                      <TableCell className="font-mono text-[13px]">{a.number}</TableCell>
                      <TableCell>{a.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(a.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </section>

        {/* -- WBS ------------------------------------------------------- */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Work breakdown structure</h2>
          {payload.tasks.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No WBS tasks. Add them from the project editor.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Task</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead align="right" className="text-right">Est. hours</TableHead>
                  <TableHead align="right" className="text-right">Est. cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payload.tasks.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-[13px]">{t.code}</TableCell>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell>
                      <Badge variant={t.status === 'complete' ? 'success' : t.status === 'cancelled' ? 'outline' : 'secondary'}>
                        {TASK_STATUS_LABELS[t.status] ?? t.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{t.estimated_hours != null ? money(t.estimated_hours) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.estimated_cost != null ? money(t.estimated_cost) : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>

        {/* -- transactions --------------------------------------------- */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Transactions</h2>
          {s.documents.length === 0 ? (
            <EmptyState title="No transactions tagged to this job" description="Bills, invoices, expenses, orders, and journals with a line tagged to this project appear here." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Number</TableHead>
                  <TableHead>Party</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead align="right" className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.documents.map((d) => {
                  const link = DOC_LINKS[d.kind]
                  return (
                    <TableRow key={d.id}>
                      <TableCell className="text-slate-500 dark:text-slate-400">{d.documentDate}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{link?.label ?? d.kind.replace(/_/g, ' ')}</Badge>
                      </TableCell>
                      <TableCell className="font-medium">
                        {link ? (
                          <Link href={`${link.base}?${link.param}=${d.id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                            {d.documentNumber}
                          </Link>
                        ) : (
                          d.documentNumber
                        )}
                      </TableCell>
                      <TableCell className="text-slate-500 dark:text-slate-400">{d.partyName}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{d.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(d.amount)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </section>
      </div>
    </DetailPageLayout>
  )
}
