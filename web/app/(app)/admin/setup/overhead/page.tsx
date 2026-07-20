import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { BookOpen } from 'lucide-react'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { requirePermission } from '../../../../../lib/authz'
import { trueCostData } from '../../../../../lib/analytics/true-cost-data'
import { TrueCostView } from '../../../../(app)/analytics/true-cost/TrueCostView'
import { OverheadActions } from './OverheadActions'

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
export default async function OverheadModelSetup() {
  const authz = await requirePermission('admin.setup.manage')
  const t = await getTranslations('admin')

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
            href="/docs/project-types"
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
          <OverheadActions
            departments={data.departments.map((d) => ({ id: d.id, name: d.name, composite: d.composite }))}
            projectTypes={typesRes.rows.map((r) => ({ id: r.id, name: r.name }))}
          />
        </div>
      </div>

      {/* Current configuration — which overhead policy each project type is
          actually using, and the state of the published rate card. */}
      <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t('setup.entities.overhead-model.current')}
        </h3>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          {card.n > 0 && card.from_date
            ? t('setup.entities.overhead-model.ratesActive', { count: card.n, date: card.from_date })
            : t('setup.entities.overhead-model.noRates')}
        </p>
        <div className="flex flex-wrap gap-2">
          {typesRes.rows.map((r) => (
            <span
              key={r.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
            >
              <span className="font-medium text-slate-800 dark:text-slate-200">{r.name}</span>
              <span className="text-slate-400">·</span>
              <span className="text-slate-600 dark:text-slate-300">{methodLabel(r.overhead)}</span>
            </span>
          ))}
        </div>
      </div>
      <TrueCostView data={data} mode="setup" />
    </div>
  )
}
