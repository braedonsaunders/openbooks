import 'server-only'

import { PageHeader } from '@openbooks/ui'
import { ModuleHomeTabs } from '@/components/module-home/tabs'
import { listRuleHeads } from '../../../../../../engine/src/allocations/index.ts'
import { getAuthz } from '../../../../../lib/authz'
import { mergeHref } from '../../../../../lib/list-params'
import { RulesTable } from './RulesTable'
import { RuleDrawerHost } from './RuleDrawer'
import { DriversTab } from './drivers-tab'
import { RunsTab } from './runs-tab'

/** Shared setup header and body adapters, composed from the native page components. */

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
    <PageHeader title={title} description={description} actions={<ModuleHomeTabs tabs={tabs} ariaLabel={tabsAria} />} />
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

/** Shared allocation-driver configuration. */
export function AllocationsDriversTabSlot() {
  return <DriversTab />
}

/** Shared allocation-run history. */
export function AllocationsRunsTabSlot() {
  return <RunsTab />
}
