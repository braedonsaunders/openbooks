import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
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

/** Project statuses whose label lives in common.status; the rest in projects.status. */
const COMMON_STATUS_KEYS = new Set(['active', 'closed', 'cancelled'])
const PROJECT_STATUS_KEYS = new Set(['quoted', 'awarded', 'substantially_complete'])
const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'outline' | 'destructive'> = {
  quoted: 'secondary',
  awarded: 'warning',
  active: 'success',
  substantially_complete: 'default',
  closed: 'outline',
  cancelled: 'destructive',
}
const BILLING_METHODS = new Set(['time_and_materials', 'fixed_price', 'cost_plus'])

// documents.status → common.status catalog key (untranslated raw fallback otherwise).
const DOC_STATUS_KEYS: Record<string, string> = {
  draft: 'draft',
  pending_approval: 'pendingApproval',
  approved: 'approved',
  rejected: 'rejected',
  posted: 'posted',
  paid: 'paid',
  partially_paid: 'partiallyPaid',
  open: 'open',
  closed: 'closed',
  voided: 'voided',
  reversed: 'reversed',
  cancelled: 'cancelled',
}

// Document kind → the module drawer that opens it. labelKey lives in projects.docKinds.
const DOC_LINKS: Record<string, { base: string; param: string; labelKey: string }> = {
  bill: { base: '/ap', param: 'bill', labelKey: 'docKinds.bill' },
  vendor_bill: { base: '/ap', param: 'bill', labelKey: 'docKinds.bill' },
  customer_invoice: { base: '/ar', param: 'invoice', labelKey: 'docKinds.invoice' },
  invoice: { base: '/ar', param: 'invoice', labelKey: 'docKinds.invoice' },
  expense: { base: '/expenses', param: 'expense', labelKey: 'docKinds.expense' },
  expense_report: { base: '/expenses', param: 'expense', labelKey: 'docKinds.expense' },
  purchase_order: { base: '/purchase-orders', param: 'order', labelKey: 'docKinds.purchaseOrder' },
  sales_order: { base: '/sales-orders', param: 'order', labelKey: 'docKinds.salesOrder' },
  journal: { base: '/journal', param: 'entry', labelKey: 'docKinds.journal' },
  journal_entry: { base: '/journal', param: 'entry', labelKey: 'docKinds.journal' },
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
  const [t, tCommon] = await Promise.all([getTranslations('projects'), getTranslations('common')])
  const statusLabel = (s: string) =>
    COMMON_STATUS_KEYS.has(s) ? tCommon(`status.${s}`) : PROJECT_STATUS_KEYS.has(s) ? t(`status.${s}`) : s
  const taskStatusLabel = (s: string) =>
    s === 'complete' ? t('taskStatus.complete') : s === 'open' || s === 'cancelled' ? tCommon(`status.${s}`) : s
  const docStatusLabel = (s: string) => (DOC_STATUS_KEYS[s] ? tCommon(`status.${DOC_STATUS_KEYS[s]}`) : s)

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
                {statusLabel(pr.status as string)}
              </Badge>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {[
                payload.customerName,
                pr.billing_method
                  ? BILLING_METHODS.has(pr.billing_method as string)
                    ? t(`billing.${pr.billing_method as string}`)
                    : (pr.billing_method as string)
                  : null,
                (() => {
                  const starts = fmtDate(pr.starts_on)
                  const ends = fmtDate(pr.ends_on)
                  if (starts && ends) return `${starts} → ${ends}`
                  if (starts) return t('cockpit.starts', { date: starts })
                  if (ends) return t('cockpit.ends', { date: ends })
                  return null
                })(),
              ]
                .filter(Boolean)
                .join('  ·  ') || t('cockpit.subtitle')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/projects?project=${id}`}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {tCommon('actions.edit')}
            </Link>
            <Link
              href="/projects"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
            >
              {t('cockpit.allProjects')}
            </Link>
          </div>
        </div>
      }
    >
      <div className="space-y-8">
        {/* -- summary stat cards ---------------------------------------- */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label={t('labels.contractValue')} value={money(s.budget.contractValue)} />
          <Stat label={t('cockpit.costBudget')} value={money(costBudget)} />
          <Stat label={t('labels.actualCost')} value={money(actualCost)} />
          <Stat label={t('cockpit.committedCost')} value={money(committedCost)} />
          <Stat label={t('cockpit.projectedCost')} value={money(projectedCost)} tone={overBudget ? 'bad' : undefined} />
          <Stat
            label={t('cockpit.remainingBudget')}
            value={money(s.forecast.remainingBudget)}
            tone={s.forecast.remainingBudget < 0 ? 'bad' : 'good'}
          />
          <Stat label={t('cockpit.actualRevenue')} value={money(s.actual.revenue)} />
          <Stat label={t('cockpit.margin')} value={money(margin)} tone={margin < 0 ? 'bad' : 'good'} />
          <Stat
            label={t('cockpit.percentSpent')}
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
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cockpit.budgetBarTitle')}</h2>
                <span className={cn('text-sm font-medium tabular-nums', overBudget ? 'text-red-600 dark:text-red-400' : 'text-teal-700 dark:text-teal-300')}>
                  {overBudget
                    ? t('cockpit.overBudget', { amount: money(projectedCost - costBudget) })
                    : costBudget > 0
                      ? t('cockpit.underBudget', { amount: money(costBudget - projectedCost) })
                      : t('cockpit.noCostBudget')}
                </span>
              </div>
              <div className="relative h-6 w-full overflow-hidden rounded-md bg-slate-100 dark:bg-slate-800">
                {/* actual */}
                <div
                  className="absolute inset-y-0 left-0 bg-teal-500"
                  style={{ width: `${actualPct}%` }}
                  title={t('cockpit.actualAmount', { amount: money(actualCost) })}
                />
                {/* committed, stacked after actual */}
                <div
                  className="absolute inset-y-0 bg-amber-400"
                  style={{ left: `${actualPct}%`, width: `${committedPct}%` }}
                  title={t('cockpit.committedAmount', { amount: money(committedCost) })}
                />
                {/* budget marker */}
                {costBudget > 0 ? (
                  <div
                    className="absolute inset-y-0 w-0.5 bg-slate-900 dark:bg-white"
                    style={{ left: `${budgetMarkerPct}%` }}
                    title={t('cockpit.costBudgetAmount', { amount: money(costBudget) })}
                  />
                ) : null}
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-teal-500" /> {t('cockpit.actualAmount', { amount: money(actualCost) })}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400" /> {t('cockpit.committedAmount', { amount: money(committedCost) })}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-0.5 bg-slate-900 dark:bg-white" /> {t('cockpit.costBudgetAmount', { amount: money(costBudget) })}
                </span>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* -- cost by category + by account ----------------------------- */}
        <section className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cockpit.costByCategory')}</h2>
            {s.costByCategory.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('cockpit.noPostedCosts')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('cockpit.category')}</TableHead>
                    <TableHead align="right" className="text-right">{tCommon('labels.amount')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.costByCategory.map((c) => (
                    <TableRow key={c.category}>
                      <TableCell>
                        {c.category === 'cogs' || c.category === 'operating_expense'
                          ? t(`cockpit.categories.${c.category}`)
                          : c.category}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(c.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cockpit.costByAccount')}</h2>
            {s.costByAccount.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('cockpit.noPostedCosts')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tCommon('labels.account')}</TableHead>
                    <TableHead>{tCommon('labels.name')}</TableHead>
                    <TableHead align="right" className="text-right">{tCommon('labels.amount')}</TableHead>
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
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cockpit.wbsTitle')}</h2>
          {payload.tasks.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('cockpit.noWbsTasks')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('labels.code')}</TableHead>
                  <TableHead>{t('labels.task')}</TableHead>
                  <TableHead>{tCommon('labels.status')}</TableHead>
                  <TableHead align="right" className="text-right">{t('labels.estHours')}</TableHead>
                  <TableHead align="right" className="text-right">{t('labels.estCost')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payload.tasks.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell className="font-mono text-[13px]">{task.code}</TableCell>
                    <TableCell className="font-medium">{task.name}</TableCell>
                    <TableCell>
                      <Badge variant={task.status === 'complete' ? 'success' : task.status === 'cancelled' ? 'outline' : 'secondary'}>
                        {taskStatusLabel(task.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{task.estimated_hours != null ? money(task.estimated_hours) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{task.estimated_cost != null ? money(task.estimated_cost) : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>

        {/* -- transactions --------------------------------------------- */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cockpit.transactions')}</h2>
          {s.documents.length === 0 ? (
            <EmptyState title={t('cockpit.noTransactionsTitle')} description={t('cockpit.noTransactionsDescription')} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tCommon('labels.date')}</TableHead>
                  <TableHead>{t('labels.kind')}</TableHead>
                  <TableHead>{tCommon('labels.number')}</TableHead>
                  <TableHead>{tCommon('labels.party')}</TableHead>
                  <TableHead>{tCommon('labels.status')}</TableHead>
                  <TableHead align="right" className="text-right">{tCommon('labels.amount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.documents.map((d) => {
                  const link = DOC_LINKS[d.kind]
                  return (
                    <TableRow key={d.id}>
                      <TableCell className="text-slate-500 dark:text-slate-400">{d.documentDate}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{link ? t(link.labelKey) : d.kind.replace(/_/g, ' ')}</Badge>
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
                        <Badge variant="outline">{docStatusLabel(d.status)}</Badge>
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
