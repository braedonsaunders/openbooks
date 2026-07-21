import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { BookOpen } from 'lucide-react'
import { cn } from '@openbooks/ui'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { requirePermission } from '../../../../../lib/authz'
import { trueCostData } from '../../../../../lib/analytics/true-cost-data'
import { TrueCostView } from '../../../../(app)/analytics/true-cost/TrueCostView'
import { OverheadActions } from './OverheadActions'
import { OverheadApplication } from './OverheadApplication'
import { countUnappliedOverheadTime, listOverheadApplications, overheadApplicationSettings } from '@openbooks/engine/src/overhead-apply.ts'
import { OverheadLifecycle } from './OverheadLifecycle'
import { RatesTab } from './RatesTab'
import { currentPublishedRates } from '../../../../../lib/overhead-publish'

export const dynamic = 'force-dynamic'

/**
 * Overhead Model — the rate-engine BUILDER, lifted out of the True Cost
 * analytics dashboard (which is now a read-only consumer). Cost pools /
 * categories, the department rate matrix, and the engine configuration
 * (allocation bases, composite method, profiles) are edited here; the resolved
 * per-department composite $/hr rates drive both the True Cost dashboard and
 * project-costing overhead (OverheadSource method `rate_engine`).
 *
 * Window: trailing 12 months — the same window the project-costing bridge uses,
 * so the rates previewed here are the rates projects get.
 */
const VIEWS = ['model', 'rates', 'lifecycle', 'application'] as const
type OverheadView = (typeof VIEWS)[number]

export default async function OverheadModelSetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('admin.setup.manage')
  const t = await getTranslations('admin')
  const sp = await searchParams
  const rawView = typeof sp.view === 'string' ? sp.view : ''
  const view: OverheadView = (VIEWS as readonly string[]).includes(rawView) ? (rawView as OverheadView) : 'model'
  const rowParam = typeof sp.row === 'string' ? sp.row : null

  const to = new Date()
  const from = new Date(to)
  from.setFullYear(from.getFullYear() - 1)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const data = await trueCostData(authz.user.orgId, { from: iso(from), to: iso(to), label: 'TTM' })
  const typesRes = (await db.execute(sql`
    select id, name, financial_profile->'overhead' as overhead
      from project_types where org_id = ${authz.user.orgId} and is_active
     order by sort_order, name`)) as unknown as {
    rows: { id: string; name: string; overhead: { method?: string; ratePercent?: number; ratePerHour?: number } | null }[]
  }
  const cardRes = (await db.execute(sql`
    select count(*)::int as n, min(effective_from)::text as from_date
      from overhead_rates where org_id = ${authz.user.orgId}
       and (effective_to is null or effective_to >= current_date)`)) as unknown as {
    rows: { n: number; from_date: string | null }[]
  }
  const card = cardRes.rows[0] ?? { n: 0, from_date: null }
  const lifecycleRes = (await db.execute(sql`
    select settings->'overheadRateLifecycle' as c from orgs where id = ${authz.user.orgId}`)) as unknown as {
    rows: { c: { mode?: string; cadence?: string } | null }[]
  }
  const lifecycleCfg = lifecycleRes.rows[0]?.c ?? {}
  const lifecycle = {
    mode: (['manual', 'scheduled', 'live'].includes(lifecycleCfg.mode ?? '') ? lifecycleCfg.mode : 'manual') as 'manual' | 'scheduled' | 'live',
    cadence: (lifecycleCfg.cadence === 'quarterly' ? 'quarterly' : 'monthly') as 'monthly' | 'quarterly',
  }
  const publishedRates = await currentPublishedRates(authz.user.orgId)
  const drift = data.departments
    .filter((d) => d.composite > 0 || publishedRates.has(d.id))
    .map((d) => ({ id: d.id, name: d.name, live: Math.round(d.composite * 100) / 100, published: publishedRates.get(d.id) ?? null }))
  const [application, applications, unapplied, accountsRes] = await Promise.all([
    overheadApplicationSettings(authz.user.orgId),
    listOverheadApplications(authz.user.orgId),
    countUnappliedOverheadTime(authz.user.orgId),
    db.execute(sql`select id, number, name from accounts where org_id = ${authz.user.orgId} and is_active order by number nulls last, name`),
  ])

  const methodLabel = (oh: { method?: string; ratePercent?: number; ratePerHour?: number } | null) => {
    switch (oh?.method) {
      case 'rate_engine': return t('setup.entities.overhead-model.methodCard')
      case 'percent_of_labor': return t('setup.entities.overhead-model.methodPct', { rate: oh.ratePercent ?? 0 })
      case 'per_labor_hour': return t('setup.entities.overhead-model.methodHr', { rate: (oh.ratePerHour ?? 0).toFixed(2) })
      case 'account_group_actual': return t('setup.entities.overhead-model.methodGl')
      default: return t('setup.entities.overhead-model.methodNone')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {t('setup.entities.overhead-model.title')}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t('setup.entities.overhead-model.description')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/docs/overhead-costing"
            className="flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            <BookOpen size={13} aria-hidden /> {t('setup.entities.overhead-model.docs')}
          </Link>
          <Link
            href="/analytics/true-cost"
            className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            {t('setup.entities.overhead-model.viewAnalytics')} →
          </Link>
          <Link
            href="/admin/setup/labor-costing"
            className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            {t('setup.entities.overhead-model.laborCostingLink')} →
          </Link>
          <OverheadActions
            departments={data.departments.map((d) => ({ id: d.id, name: d.name, composite: d.composite }))}
            projectTypes={typesRes.rows.map((r) => ({ id: r.id, name: r.name }))}
            autoOpen={card.n === 0 && !typesRes.rows.some((r) => r.overhead?.method && r.overhead.method !== 'none')}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {VIEWS.map((item) => (
          <Link
            key={item}
            href={`/admin/setup/overhead?view=${item}`}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              view === item
                ? 'border-teal-600 text-teal-700 dark:text-teal-300'
                : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100',
            )}
          >
            {t(`setup.entities.overhead-model.tabs.${item}`)}
          </Link>
        ))}
      </div>

      {view === 'model' && (<>
      {/* Guided flow — the three steps of overhead setup, each showing its
          live state so it is always clear where you are and what is next. */}
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          {
            n: 1,
            title: t('setup.entities.overhead-model.step1t'),
            desc: t('setup.entities.overhead-model.step1d', { count: data.categories.length, unassigned: data.unassigned.length }),
            done: data.categories.length > 0 && data.unassigned.length === 0,
          },
          {
            n: 2,
            title: t('setup.entities.overhead-model.step2t'),
            desc: t('setup.entities.overhead-model.step2d', { rate: data.kpis.compositeRate.toFixed(2) }),
            done: data.kpis.compositeRate > 0,
          },
          {
            n: 3,
            title: t('setup.entities.overhead-model.step3t'),
            desc:
              card.n > 0 && card.from_date
                ? t('setup.entities.overhead-model.ratesActive', { count: card.n, date: card.from_date })
                : t('setup.entities.overhead-model.noRates'),
            done: card.n > 0 && typesRes.rows.some((r) => r.overhead?.method && r.overhead.method !== 'none'),
          },
        ].map((s) => (
          <div key={s.n} className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-1 flex items-center gap-2">
              <span
                className={
                  'grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold ' +
                  (s.done
                    ? 'bg-teal-600 text-white dark:bg-teal-500 dark:text-slate-950'
                    : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-200')
                }
              >
                {s.done ? '✓' : s.n}
              </span>
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{s.title}</span>
            </div>
            <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">{s.desc}</p>
          </div>
        ))}
      </div>

      {/* Active policy per project type. */}
      <div className="flex flex-wrap gap-1.5">
        {typesRes.rows.map((r) => (
          <span
            key={r.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-950"
          >
            <span className="font-medium text-slate-800 dark:text-slate-200">{r.name}</span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-600 dark:text-slate-300">{methodLabel(r.overhead)}</span>
          </span>
        ))}
      </div>
      </>)}
      {view === 'rates' && <RatesTab orgId={authz.user.orgId} rowParam={rowParam} />}
      {view === 'lifecycle' && (
        <OverheadLifecycle mode={lifecycle.mode} cadence={lifecycle.cadence} drift={drift} />
      )}
      {view === 'application' && (
      <OverheadApplication
        mode={application.mode}
        accountId={application.accountId}
        accounts={(accountsRes as unknown as { rows: Record<string, unknown>[] }).rows.map((r) => ({
          id: String(r.id),
          label: r.number ? `${r.number} · ${r.name}` : String(r.name ?? ''),
        }))}
        applications={applications}
        unapplied={unapplied}
      />
      )}
      {view === 'model' && <TrueCostView data={data} mode="setup" />}
    </div>
  )
}
