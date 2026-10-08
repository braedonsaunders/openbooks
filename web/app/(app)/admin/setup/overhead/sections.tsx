import { ModuleHomeTabs } from '@/components/module-home/tabs'
import 'server-only'

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { BookOpen } from 'lucide-react'
import { TrueCostSetupView } from './TrueCostSetupView'
import { OverheadActions, type DeptRate, type TypeOpt } from './OverheadActions'
import { OverheadApplication, type ApplicationRow } from './OverheadApplication'
import { OverheadLifecycle, type DriftRow } from './OverheadLifecycle'
import { RatesTab } from './RatesTab'
import type { TrueCostSetupData } from '../../../../../lib/analytics/true-cost-setup-data'
import { getAuthz, guardRootSubsidiaryScope } from '../../../../../lib/authz'
import { currentPublishedRates } from '../../../../../lib/overhead-publish'
import { businessToday, parseIsoDate } from '@openbooks/engine/src/platform/business-date.ts'
import { trueCostData } from '../../../../../lib/analytics/true-cost-data'
import { isFeatureEnabled } from '../../../../../lib/features'
import {
  countUnappliedOverheadTime,
  listOverheadApplications,
} from '@openbooks/engine/src/allocations/overhead-post.ts'
import {
  getOverheadSystemRuleEvidence,
  overheadApplicationSettings,
  type OverheadSystemRuleEvidence,
} from '@openbooks/engine/src/allocations/overhead-sync.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { sql } from 'drizzle-orm'
import type { OverheadPolicy, OverheadStep } from './view'

async function getRootScopeAuthz() {
  const authz = await getAuthz()
  if (!authz) return null
  if (await guardRootSubsidiaryScope(authz)) notFound()
  return authz
}

/**
 * Shared chrome and tab-body slots for the Overhead Model setup workspace.
 *
 * The header row (title, description, docs/analytics/labor links, the
 * client-only OverheadActions island) and the view tab strip are chrome the
 * spec cannot express: the strip's active-vs-plain link PAIR is a
 * conditional pair, and OverheadActions owns `useState` plus the money and
 * business-day hooks. `OverheadModelHeader` renders both verbatim, and
 * page.tsx imports it back so there is one implementation —
 * the payroll-sections precedent.
 *
 * Session-derived slots retain their own scope gates. The model and
 * lifecycle share the loader's live department calculation with the header;
 * the lifecycle slot reads the current published card independently.
 */

export function OverheadModelHeader({
  title,
  description,
  docsHref,
  docsLabel,
  analyticsHref,
  analyticsLabel,
  laborHref,
  laborLabel,
  actions,
  tabs,
}: {
  title: string
  description: string
  docsHref: string
  docsLabel: string
  analyticsHref: string
  analyticsLabel: string
  laborHref: string
  laborLabel: string
  actions: { departments: DeptRate[]; projectTypes: TypeOpt[]; autoOpen: boolean }
  tabs: { href: string; label: string; active: boolean }[]
}) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {title}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {description}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={docsHref as never}
            className="flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            <BookOpen size={13} aria-hidden /> {docsLabel}
          </Link>
          <Link
            href={analyticsHref as never}
            className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            {analyticsLabel} →
          </Link>
          <Link
            href={laborHref as never}
            className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            {laborLabel} →
          </Link>
          <OverheadActions
            departments={actions.departments}
            projectTypes={actions.projectTypes}
            autoOpen={actions.autoOpen}
          />
        </div>
      </div>

      <ModuleHomeTabs tabs={tabs} />
    </>
  )
}

export function OverheadModelBody({
  steps,
  policies,
  trueCost,
}: {
  steps: OverheadStep[]
  policies: OverheadPolicy[]
  trueCost: TrueCostSetupData
}) {
  return (
    <>
      {/* Guided flow — the three steps of overhead setup, each showing its
          live state so it is always clear where you are and what is next. */}
      <div className="grid gap-3 sm:grid-cols-3">
        {steps.map((s) => (
          <div key={s.n} className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-1 flex items-center gap-2">
              <span
                className={
                  'grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold ' +
                  (s.badgeDone
                    ? 'bg-teal-600 text-white dark:bg-teal-500 dark:text-slate-950'
                    : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-200')
                }
              >
                {s.badge}
              </span>
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{s.title}</span>
            </div>
            <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">{s.desc}</p>
          </div>
        ))}
      </div>

      {/* Active policy per project type. */}
      <div className="flex flex-wrap gap-1.5">
        {policies.map((r) => (
          <span
            key={r.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-950"
          >
            <span className="font-medium text-slate-800 dark:text-slate-200">{r.name}</span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-600 dark:text-slate-300">{r.methodLabel}</span>
          </span>
        ))}
      </div>
      <TrueCostSetupView data={trueCost} />
    </>
  )
}

/** Rates tab slot: the published rate card plus its `?row=` drawer. */
export async function OverheadRatesTabSlot({
  sp,
}: {
  sp: Record<string, string | string[] | undefined>
}) {
  const authz = await getRootScopeAuthz()
  if (!authz) return null
  const orgId = authz.user.orgId
  return <RatesTab orgId={orgId} searchParams={sp} />
}

/** Lifecycle tab slot: mode/cadence switch plus the drift table. */
export async function OverheadLifecycleTabSlot({ departments }: { departments?: DeptRate[] } = {}) {
  const authz = await getRootScopeAuthz()
  if (!authz) return null
  const orgId = authz.user.orgId
  const liveDepartments = async () => {
    if (departments) {
      // Retain the slot's Projects gate when presentation rows are supplied.
      if (!(await isFeatureEnabled(orgId, 'projects'))) throw new Error('projects feature is disabled')
      return departments
    }
    // Stored layouts may still place this widget without department props.
    // Resolve the same native calculation for that composition.
    const today = await businessToday(orgId)
    const fromDate = parseIsoDate(today)
    fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 1)
    const from = fromDate.toISOString().slice(0, 10)
    return (await trueCostData(orgId, { from, to: today, label: 'TTM' }, authz.allowedSubsidiaryIds, undefined, { includePriorComparison: false })).departments
  }
  const [live, lifecycleRes, publishedRates] = await Promise.all([
    liveDepartments(),
    db.execute<{ c: { mode?: string; cadence?: string } | null }>(sql`
      select settings->'overheadRateLifecycle' as c from orgs where id = ${orgId}`),
    currentPublishedRates(orgId),
  ])
  const lifecycleCfg = lifecycleRes.rows[0]?.c ?? {}
  const lifecycle = {
    mode: (['manual', 'scheduled', 'live'].includes(lifecycleCfg.mode ?? '') ? lifecycleCfg.mode : 'manual') as 'manual' | 'scheduled' | 'live',
    cadence: (lifecycleCfg.cadence === 'quarterly' ? 'quarterly' : 'monthly') as 'monthly' | 'quarterly',
  }
  const drift: DriftRow[] = live
    .filter((d) => (d.composite ?? 0) > 0 || publishedRates.has(d.id))
    .map((d) => ({ id: d.id, name: d.name, live: d.composite == null ? null : Math.round(d.composite * 100) / 100, published: publishedRates.get(d.id) ?? null }))
  return <OverheadLifecycle mode={lifecycle.mode} cadence={lifecycle.cadence} drift={drift} />
}

/** Application tab slot: mode switch, ledger postings, unapplied prompt. */
export async function OverheadApplicationTabSlot() {
  const authz = await getRootScopeAuthz()
  if (!authz) return null
  const orgId = authz.user.orgId
  const [application, applications, unapplied, accountsRes, systemRule] = await Promise.all([
    overheadApplicationSettings(orgId),
    listOverheadApplications(orgId),
    countUnappliedOverheadTime(orgId),
    db.execute(sql`select id, number, name from accounts where org_id = ${orgId} and is_active order by number nulls last, name`),
    getOverheadSystemRuleEvidence(orgId),
  ])
  const systemRuleEvidence: OverheadSystemRuleEvidence | null = systemRule.ruleId ? systemRule : null
  return (
    <OverheadApplication
      mode={application.mode}
      accountId={application.accountId}
      accounts={(accountsRes as unknown as { rows: Record<string, unknown>[] }).rows.map((r) => ({
        id: String(r.id),
        label: r.number ? `${r.number} · ${r.name}` : String(r.name ?? ''),
      }))}
      applications={applications as ApplicationRow[]}
      unapplied={unapplied}
      systemRule={systemRuleEvidence}
    />
  )
}
