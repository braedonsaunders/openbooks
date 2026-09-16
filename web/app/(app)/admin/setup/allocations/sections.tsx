import 'server-only'

import Link from 'next/link'
import { cn } from '@openbooks/ui'
import { listRuleHeads } from '../../../../../../engine/src/allocations/index.ts'
import { getAuthz } from '../../../../../lib/authz'
import { mergeHref } from '../../../../../lib/list-params'
import { RulesTable } from './RulesTable'
import { RuleDrawerHost } from './RuleDrawer'
import { DriversTab } from './drivers-tab'
import { RunsTab } from './runs-tab'

/**
 * Shared chrome and tab-body slots for the Allocations setup workspace.
 *
 * The header row (h1, description, tab strip) is one shared component over
 * loader-resolved strings — the depreciation precedent (class strings
 * transcribed verbatim). The tab strip stays A7-owned; the Drivers/Runs tab
 * bodies below mount A8's islands unchanged.
 *
 * Like every tab slot, the bodies re-derive the org id from the session — a
 * spec never carries an org id. The Rules slot loads heads server-side and
 * hands them to the client table; the `?rule=` drawer state is read
 * client-side by the drawer host (next commit).
 */

export interface AllocationsSetupTab {
  key: string
  href: string
  label: string
  active: boolean
}

export function AllocationsSetupHeader({
  title,
  description,
  tabs,
  tabsAria,
}: {
  title: string
  description: string
  tabs: AllocationsSetupTab[]
  tabsAria: string
}) {
  return (
    <>
      <header><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p></header>
      <nav className="flex gap-1 border-b border-slate-200 dark:border-slate-800" aria-label={tabsAria}>
        {tabs.map((item) => <Link key={item.key} href={item.href as never}
          aria-current={item.active ? 'page' : undefined}
          className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium', item.active ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400')}>
          {item.label}
        </Link>)}
      </nav>
    </>
  )
}

/** Rules tab slot: the versioned rule list with its `?rule=` drawer. */
export async function AllocationsRulesTabSlot({
  sp,
}: {
  sp: Record<string, string | string[] | undefined>
}) {
  const authz = await getAuthz()
  if (!authz) return null
  const rules = await listRuleHeads(authz.user.orgId)
  return <RulesTable rules={rules} currentParams={sp} />
}

/**
 * Rule drawer slot: mounted on every tab (Rules rows and the Runs period
 * deep-link both address `?rule=`). Without the param it renders nothing;
 * with it the host owns the UrlDrawer and fetches behind the API gates, so
 * the slot itself needs no session read.
 */
export function AllocationsRuleDrawerSlot({
  sp,
}: {
  sp: Record<string, string | string[] | undefined>
}) {
  const rule = typeof sp.rule === 'string' && sp.rule !== '' ? sp.rule : null
  if (rule === null) return null
  return <RuleDrawerHost ruleParam={rule} closeHref={mergeHref('/admin/setup/allocations', sp, { rule: undefined })} />
}

/**
 * Drivers tab — OWNED BY A8 (drivers + runs slice). Mounted unchanged; the
 * tab strip above stays A7-owned.
 */
export function AllocationsDriversTabSlot() {
  return <DriversTab />
}

/**
 * Runs tab — OWNED BY A8 (drivers + runs slice). Same contract as Drivers.
 */
export function AllocationsRunsTabSlot() {
  return <RunsTab />
}
