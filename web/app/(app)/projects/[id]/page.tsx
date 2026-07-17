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
import { getRecordType, fieldMetaFor, type FormLayoutConfig } from '@openbooks/customization'
import { DetailPageLayout } from '../../../../components/page-layout'
import { DetailSubtabs } from '../../../../components/detail-subtabs'
import { requirePermission } from '../../../../lib/authz'
import { isUuid, pickString } from '../../../../lib/list-params'
import { money } from '../../../../lib/format'
import { projectCostSummary, projectTimeSummary, projectUnbilled } from '../../../../lib/project-costing'
import { resolveFormLayout } from '../../../../lib/customization/resolve'
import { loadFieldDefs } from '../../../../lib/custom-fields'
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

const hours = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })

export default async function ProjectCockpit({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [t, tCommon] = await Promise.all([getTranslations('projects'), getTranslations('common')])
  const tRoot = await getTranslations()
  const statusLabel = (s: string) =>
    COMMON_STATUS_KEYS.has(s) ? tCommon(`status.${s}`) : PROJECT_STATUS_KEYS.has(s) ? t(`status.${s}`) : s
  const billingLabel = (b: string) => (BILLING_METHODS.has(b) ? t(`billing.${b}`) : b)
  const taskStatusLabel = (s: string) =>
    s === 'complete' ? t('taskStatus.complete') : s === 'open' || s === 'cancelled' ? tCommon(`status.${s}`) : s
  const docStatusLabel = (s: string) => (DOC_STATUS_KEYS[s] ? tCommon(`status.${DOC_STATUS_KEYS[s]}`) : s)

  const authz = await requirePermission('projects.read')
  const orgId = authz.user.orgId
  const { id } = await params
  if (!isUuid(id)) notFound()

  const [payload, summary, time, unbilled, layoutRes] = await Promise.all([
    loadProject(id, orgId),
    projectCostSummary(orgId, id),
    projectTimeSummary(orgId, id),
    projectUnbilled(orgId, id),
    (async () =>
      resolveFormLayout({
        orgId,
        userId: authz.user.id,
        recordType: 'project',
        userRoles: [authz.user.role],
        headerDefs: await loadFieldDefs('projects'),
        lineDefs: [],
      }))(),
  ])
  if (!payload) notFound()

  const pr = payload.project
  const s = summary
  const custom = (pr.custom as Record<string, unknown> | null) ?? {}
  const cfByKey = new Map((payload.customFieldDefs ?? []).map((d) => [`cf_${d.key}`, d]))

  const sp = await searchParams
  const TAB_KEYS = ['overview', 'financials', 'cost_time', 'documents'] as const
  const tabParam = pickString(sp.tab)
  const activeTab = (TAB_KEYS as readonly string[]).includes(tabParam ?? '') ? tabParam! : 'overview'
  const tabs = TAB_KEYS.map((key) => ({ key, label: t(`cockpit.tabs.${key}`) }))

  const projectedCost = s.forecast.projectedCost
  const costBudget = s.budget.cost
  const actualCost = s.actual.cost
  const committedCost = s.committed.cost
  const margin = s.actual.margin
  const scale = Math.max(costBudget, projectedCost, 1)
  const actualPct = Math.min(100, (actualCost / scale) * 100)
  const committedPct = Math.min(100 - actualPct, (committedCost / scale) * 100)
  const budgetMarkerPct = Math.min(100, (costBudget / scale) * 100)
  const overBudget = projectedCost > costBudget && costBudget > 0
  const fmtDate = (d: unknown) => (d ? String(d) : null)

  // -- read-only value + label for one header-field placement (Overview tab) --
  const fieldLabel = (key: string, override?: string | null): string => {
    if (override && override.trim()) return override.trim()
    const cf = cfByKey.get(key)
    if (cf) return cf.label
    const meta = fieldMetaFor('project', key)
    return meta ? tRoot(meta.labelKey as never) : key
  }
  const fieldValue = (key: string): string => {
    switch (key) {
      case 'name': return (pr.name as string) ?? '—'
      case 'code': return (pr.code as string) || '—'
      case 'customer_id': return payload.customerName ?? '—'
      case 'status': return statusLabel(pr.status as string)
      case 'billing_method': return pr.billing_method ? billingLabel(pr.billing_method as string) : '—'
      case 'contract_value': return payload.contractValue != null ? money(payload.contractValue) : '—'
      case 'foreman_id': return payload.foremanName ?? '—'
      case 'manager_id': return payload.managerName ?? '—'
      case 'customer_po_number': return (pr.customer_po_number as string) || '—'
      case 'starts_on': return fmtDate(pr.starts_on) ?? '—'
      case 'ends_on': return fmtDate(pr.ends_on) ?? '—'
      case 'subsidiary_id': return pr.subsidiary_id ? String(pr.subsidiary_id) : '—'
      case 'notes': return (pr.notes as string) || '—'
      default: {
        const def = cfByKey.get(key)
        if (!def) return '—'
        const raw = custom[def.key]
        if (raw == null || raw === '') return '—'
        if (Array.isArray(raw)) return raw.join(', ')
        if (def.fieldType === 'boolean') return raw ? tCommon('labels.yes') : tCommon('labels.no')
        if (def.fieldType === 'currency') return money(raw as any)
        return String(raw)
      }
    }
  }

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
                pr.billing_method ? billingLabel(pr.billing_method as string) : null,
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
      subtabs={<DetailSubtabs tabs={tabs} active={activeTab} basePath={`/projects/${id}`} />}
    >
      {activeTab === 'overview' ? (
        <OverviewTab layout={layoutRes.layout} fieldLabel={fieldLabel} fieldValue={fieldValue} />
      ) : null}

      {activeTab === 'financials' ? (
        <div className="space-y-8">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label={t('labels.contractValue')} value={money(s.budget.contractValue)} />
            <Stat label={t('cockpit.costBudget')} value={money(costBudget)} />
            <Stat label={t('labels.actualCost')} value={money(actualCost)} />
            <Stat label={t('cockpit.committedCost')} value={money(committedCost)} />
            <Stat label={t('cockpit.projectedCost')} value={money(projectedCost)} tone={overBudget ? 'bad' : undefined} />
            <Stat label={t('cockpit.remainingBudget')} value={money(s.forecast.remainingBudget)} tone={s.forecast.remainingBudget < 0 ? 'bad' : 'good'} />
            <Stat label={t('cockpit.actualRevenue')} value={money(s.actual.revenue)} />
            <Stat label={t('cockpit.margin')} value={money(margin)} tone={margin < 0 ? 'bad' : 'good'} />
            <Stat label={t('cockpit.unbilled')} value={money(unbilled.revenue)} tone={unbilled.revenue > 0 ? 'good' : undefined} />
            <Stat
              label={t('cockpit.percentSpent')}
              value={s.forecast.percentSpent == null ? '—' : (s.forecast.percentSpent * 100).toFixed(1)}
              suffix={s.forecast.percentSpent == null ? undefined : '%'}
              tone={overBudget ? 'bad' : undefined}
            />
          </section>

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
                  <div className="absolute inset-y-0 left-0 bg-teal-500" style={{ width: `${actualPct}%` }} title={t('cockpit.actualAmount', { amount: money(actualCost) })} />
                  <div className="absolute inset-y-0 bg-amber-400" style={{ left: `${actualPct}%`, width: `${committedPct}%` }} title={t('cockpit.committedAmount', { amount: money(committedCost) })} />
                  {costBudget > 0 ? (
                    <div className="absolute inset-y-0 w-0.5 bg-slate-900 dark:bg-white" style={{ left: `${budgetMarkerPct}%` }} title={t('cockpit.costBudgetAmount', { amount: money(costBudget) })} />
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                  <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-teal-500" /> {t('cockpit.actualAmount', { amount: money(actualCost) })}</span>
                  <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400" /> {t('cockpit.committedAmount', { amount: money(committedCost) })}</span>
                  <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-0.5 bg-slate-900 dark:bg-white" /> {t('cockpit.costBudgetAmount', { amount: money(costBudget) })}</span>
                </div>
              </CardContent>
            </Card>
          </section>

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
                        <TableCell>{c.category === 'cogs' || c.category === 'operating_expense' ? t(`cockpit.categories.${c.category}`) : c.category}</TableCell>
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
        </div>
      ) : null}

      {activeTab === 'cost_time' ? (
        <div className="space-y-8">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t('cockpit.totalHours')} value={hours(time.totals.hours)} />
            <Stat label={t('cockpit.billableHours')} value={hours(time.totals.billableHours)} />
            <Stat label={t('cockpit.laborCost')} value={money(time.totals.cost)} />
            <Stat label={t('cockpit.laborBill')} value={money(time.totals.bill)} tone="good" />
          </section>
          <section className="grid gap-6 lg:grid-cols-2">
            <TimeTable title={t('cockpit.timeByTask')} rows={time.byTask} unlabeled={t('cockpit.unassignedTask')} labelHead={t('labels.task')} hoursHead={t('cockpit.hoursHead')} billableHead={t('cockpit.billableHead')} costHead={t('labels.actualCost')} billHead={t('cockpit.billValue')} money={money} hours={hours} empty={t('cockpit.noTime')} />
            <TimeTable title={t('cockpit.timeByEmployee')} rows={time.byEmployee} unlabeled={t('cockpit.unassignedEmployee')} labelHead={tCommon('labels.employee')} hoursHead={t('cockpit.hoursHead')} billableHead={t('cockpit.billableHead')} costHead={t('labels.actualCost')} billHead={t('cockpit.billValue')} money={money} hours={hours} empty={t('cockpit.noTime')} />
          </section>
        </div>
      ) : null}

      {activeTab === 'documents' ? (
        <div className="space-y-8">
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
                        <Badge variant={task.status === 'complete' ? 'success' : task.status === 'cancelled' ? 'outline' : 'secondary'}>{taskStatusLabel(task.status)}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{task.estimated_hours != null ? money(task.estimated_hours) : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{task.estimated_cost != null ? money(task.estimated_cost) : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

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
                        <TableCell><Badge variant="secondary">{link ? t(link.labelKey) : d.kind.replace(/_/g, ' ')}</Badge></TableCell>
                        <TableCell className="font-medium">
                          {link ? (
                            <Link href={`${link.base}?${link.param}=${d.id}`} className="text-teal-700 hover:underline dark:text-teal-300">{d.documentNumber}</Link>
                          ) : (
                            d.documentNumber
                          )}
                        </TableCell>
                        <TableCell className="text-slate-500 dark:text-slate-400">{d.partyName}</TableCell>
                        <TableCell><Badge variant="outline">{docStatusLabel(d.status)}</Badge></TableCell>
                        <TableCell className="text-right tabular-nums">{money(d.amount)}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </section>
        </div>
      ) : null}
    </DetailPageLayout>
  )
}

/** Read-only render of the resolved project form — surfaces the configured form
 *  (native + custom fields, in the designer's order/grouping) on the cockpit. */
function OverviewTab({
  layout,
  fieldLabel,
  fieldValue,
}: {
  layout: FormLayoutConfig
  fieldLabel: (key: string, override?: string | null) => string
  fieldValue: (key: string) => string
}) {
  return (
    <div className="space-y-6">
      {layout.header.groups.map((group) => {
        const visible = group.fields.filter((f) => f.visible)
        if (visible.length === 0) return null
        return (
          <section key={group.id} className="space-y-3">
            {group.label && group.label.trim() ? (
              <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{group.label}</h2>
            ) : null}
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((placement) => (
                <div key={placement.key}>
                  <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">{fieldLabel(placement.key, placement.labelOverride)}</dt>
                  <dd className="mt-0.5 text-sm text-slate-900 dark:text-slate-100">{fieldValue(placement.key)}</dd>
                </div>
              ))}
            </dl>
          </section>
        )
      })}
    </div>
  )
}

function TimeTable({
  title,
  rows,
  unlabeled,
  labelHead,
  hoursHead,
  billableHead,
  costHead,
  billHead,
  money: fmtMoney,
  hours: fmtHours,
  empty,
}: {
  title: string
  rows: { key: string | null; label: string; hours: number; billableHours: number; cost: number; bill: number }[]
  unlabeled: string
  labelHead: string
  hoursHead: string
  billableHead: string
  costHead: string
  billHead: string
  money: (v: any) => string
  hours: (v: number) => string
  empty: string
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{empty}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{labelHead}</TableHead>
              <TableHead align="right" className="text-right">{hoursHead}</TableHead>
              <TableHead align="right" className="text-right">{billableHead}</TableHead>
              <TableHead align="right" className="text-right">{costHead}</TableHead>
              <TableHead align="right" className="text-right">{billHead}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key ?? 'none'}>
                <TableCell className={r.label ? 'font-medium' : 'text-slate-400'}>{r.label || unlabeled}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtHours(r.hours)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtHours(r.billableHours)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtMoney(r.cost)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtMoney(r.bill)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
