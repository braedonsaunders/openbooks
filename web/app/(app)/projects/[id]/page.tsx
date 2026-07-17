import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge } from '@openbooks/ui'
import { getRecordType, fieldMetaFor, type FormLayoutConfig } from '@openbooks/customization'
import { DetailPageLayout } from '../../../../components/page-layout'
import { DetailSubtabs } from '../../../../components/detail-subtabs'
import { requirePermission } from '../../../../lib/authz'
import { isUuid, pickString } from '../../../../lib/list-params'
import { money } from '../../../../lib/format'
import { projectCostSummary, projectTimeSummary, projectUnbilled } from '../../../../lib/project-costing'
import { listBillingRequests } from '../../../../lib/billing-requests'
import { resolveFormLayout } from '../../../../lib/customization/resolve'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { can } from '../../../../lib/authz'
import { loadProject } from '../../../api/projects/_lib'
import { BillingSection } from './BillingSection'
import { ChargesSection } from './ChargesSection'
import { FinancialsTab } from '../tabs/FinancialsTab'
import { CostTimeTab } from '../tabs/CostTimeTab'
import { TransactionsTab } from '../tabs/TransactionsTab'

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

  const authz = await requirePermission('projects.read')
  const orgId = authz.user.orgId
  const { id } = await params
  if (!isUuid(id)) notFound()

  const [payload, summary, time, unbilled, billingReqs, layoutRes] = await Promise.all([
    loadProject(id, orgId),
    projectCostSummary(orgId, id),
    projectTimeSummary(orgId, id),
    projectUnbilled(orgId, id),
    listBillingRequests(orgId, id),
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
  const canManage = can(authz, 'projects.manage')

  // Project charges (resource usage) + item picker + absorption summary.
  const [chargeRows, itemRows] = (await Promise.all([
    db.execute(sql`
      select d.id, d.document_number as "documentNumber", d.document_date as "documentDate", d.status,
             d.total::numeric(19,4) as cost,
             coalesce(sum(dl.amount * coalesce(nullif(dl.cost_multiplier,0),1)) filter (where dl.is_billable), 0)::numeric(19,4) as "billValue",
             count(dl.*) as lines,
             bool_and(dl.billed_by_line_id is not null) filter (where dl.is_billable) as billed
        from documents d left join document_lines dl on dl.document_id = d.id
       where d.org_id = ${orgId} and d.kind = 'project_charge' and d.project_id = ${id}
       group by d.id order by d.document_date desc, d.document_number desc`),
    db.execute(sql`
      select id, name, default_cost as "defaultCost", default_rate as "defaultRate"
        from items where org_id = ${orgId} and is_active order by name limit 2000`),
  ])) as any[]
  const chargeList = chargeRows.rows as any[]
  const absorption = {
    recovered: chargeList.filter((c) => c.status === 'posted').reduce((a, c) => a + Number(c.cost), 0).toFixed(2),
    billValue: chargeList.reduce((a, c) => a + Number(c.billValue), 0).toFixed(2),
  }
  // Fixed-price revenue recognized to date (credits of revenue_recognition entries).
  const recognizedRow = (await db.execute(sql`
    select coalesce(-sum(l.amount) filter (where l.amount < 0), 0)::numeric(19,4) as recognized
      from journal_lines l join journal_entries e on e.id = l.entry_id
     where l.org_id = ${orgId} and l.project_id = ${id} and e.status = 'posted' and e.origin = 'revenue_recognition'`)) as any
  const recognizedToDate = String(recognizedRow.rows[0]?.recognized ?? '0')

  const pr = payload.project
  const s = summary
  const custom = (pr.custom as Record<string, unknown> | null) ?? {}
  const cfByKey = new Map((payload.customFieldDefs ?? []).map((d) => [`cf_${d.key}`, d]))

  const sp = await searchParams
  const TAB_KEYS = ['overview', 'financials', 'cost_time', 'charges', 'billing', 'transactions'] as const
  const tabParam = pickString(sp.tab)
  const activeTab = (TAB_KEYS as readonly string[]).includes(tabParam ?? '') ? tabParam! : 'overview'
  const tabs = TAB_KEYS.map((key) => ({ key, label: t(`cockpit.tabs.${key}`) }))

  const projectedCost = s.forecast.projectedCost
  const costBudget = s.budget.cost
  const actualCost = s.actual.cost
  const committedCost = s.committed.cost
  const margin = s.actual.margin
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
        <FinancialsTab
          projectId={id}
          billingMethod={(pr.billing_method as string) ?? null}
          recognizedToDate={recognizedToDate}
          canManage={canManage}
          data={{
            contractValue: s.budget.contractValue,
            costBudget,
            actualCost,
            committedCost,
            projectedCost,
            remainingBudget: s.forecast.remainingBudget,
            actualRevenue: s.actual.revenue,
            margin,
            unbilledRevenue: unbilled.revenue,
            percentSpent: s.forecast.percentSpent,
            costByCategory: s.costByCategory,
            costByAccount: s.costByAccount,
          }}
        />
      ) : null}

      {activeTab === 'cost_time' ? <CostTimeTab data={time} /> : null}

      {activeTab === 'charges' ? (
        <ChargesSection
          projectId={id}
          charges={chargeList as any}
          items={itemRows.rows as any}
          absorption={absorption}
          canManage={canManage}
        />
      ) : null}

      {activeTab === 'billing' ? (
        <BillingSection
          projectId={id}
          unbilled={unbilled}
          requests={billingReqs as any}
          canManage={canManage}
        />
      ) : null}

      {activeTab === 'transactions' ? (
        <TransactionsTab tasks={payload.tasks} transactions={s.documents as any} />
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
