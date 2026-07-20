import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { BookOpen } from 'lucide-react'
import { requirePermission } from '../../../../../lib/authz'
import { trueCostData } from '../../../../../lib/analytics/true-cost-data'
import { TrueCostView } from '../../../../(app)/analytics/true-cost/TrueCostView'

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
        </div>
      </div>
      <TrueCostView data={data} mode="setup" />
    </div>
  )
}
