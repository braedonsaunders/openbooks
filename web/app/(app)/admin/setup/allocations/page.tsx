import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { requirePermission } from '../../../../../lib/authz'
import { isAllocationsEnabled } from '../../../../../lib/allocations-gate'
import { DriversTab } from './drivers-tab'
import { RunsTab } from './runs-tab'
import { A8_SETUP_TABS, parseA8Tab } from './tabs'

export const dynamic = 'force-dynamic'

/**
 * TEMPORARY A8 shell for the Allocations setup workspace — A7 replaces this
 * file (and adds view.ts + the Rules tab) with the ModuleView shell. It
 * exists so the Drivers and Runs islands are exercisable and reviewable
 * before the shell lands; the tab modules themselves mount unchanged in
 * A7's strip.
 */
export default async function AllocationsSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('admin.setup.manage')
  if (!(await isAllocationsEnabled(authz.user.orgId))) redirect('/admin/setup/features')
  const sp = await searchParams
  const tab = parseA8Tab(sp.tab)
  const t = await getTranslations('allocations')

  return (
    <div className="space-y-4">
      <nav className="flex gap-1 border-b border-slate-200 dark:border-slate-800" aria-label={t('tabs.workspace')}>
        {A8_SETUP_TABS.map((item) => (
          <Link
            key={item.key}
            href={item.href as never}
            aria-current={tab === item.key ? 'page' : undefined}
            className={
              tab === item.key
                ? 'border-b-2 border-slate-900 px-3 py-2 text-sm font-medium dark:border-slate-100'
                : 'px-3 py-2 text-sm text-slate-500 hover:text-slate-900 dark:hover:text-slate-100'
            }
          >
            {t(item.labelKey)}
          </Link>
        ))}
      </nav>
      {tab === 'runs' ? <RunsTab /> : <DriversTab />}
    </div>
  )
}
