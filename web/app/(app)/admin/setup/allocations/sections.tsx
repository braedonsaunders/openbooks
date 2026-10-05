import 'server-only'

import { PageHeader } from '@openbooks/ui'
import { ModuleHomeTabs } from '@/components/module-home/tabs'
import { listRuleHeads } from '../../../../../../engine/src/allocations/index.ts'
import { getAuthz } from '../../../../../lib/authz'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../../../lib/features'
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
  basePath = '/admin/setup/allocations',
  payrollExpenses = false,
}: {
  sp: Record<string, string | string[] | undefined>
  basePath?: string
  payrollExpenses?: boolean
}) {
  const authz = await getAuthz()
  if (!authz) return null
  await requirePermission('allocations.read')
  const allocationsEnabled = await isFeatureEnabled(authz.user.orgId, 'allocations')
  if (!payrollExpenses) await requireFeatureEnabled(authz.user.orgId, 'allocations')
  const rules = allocationsEnabled ? await listRuleHeads(authz.user.orgId, { payrollExpenses, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }) : []
  const postingEnabled = payrollExpenses ? await isFeatureEnabled(authz.user.orgId, 'allocationsAtPosting') : true
  return <RulesTable rules={rules} currentParams={sp} basePath={basePath} payrollExpenses={payrollExpenses} postingEnabled={postingEnabled} allocationsEnabled={allocationsEnabled} />
}

/**
 * Rule drawer slot: mounted on every tab (Rules rows and the Runs period
 * deep-link both address `?rule=`). Without the param it renders nothing;
 * with it the host owns the UrlDrawer and fetches behind the API gates, so
 * the slot itself needs no session read.
 */
export function AllocationsRuleDrawerSlot({
  sp,
  basePath = '/admin/setup/allocations',
  payrollExpenses = false,
}: {
  sp: Record<string, string | string[] | undefined>
  basePath?: string
  payrollExpenses?: boolean
}) {
  const rule = typeof sp.rule === 'string' && sp.rule !== '' ? sp.rule : null
  if (rule === null) return null
  return <RuleDrawerHost ruleParam={rule} closeHref={mergeHref(basePath, sp, { rule: undefined })} payrollExpenses={payrollExpenses} />
}

/** Shared allocation-driver configuration. */
export function AllocationsDriversTabSlot() {
  return <DriversTab />
}

/** Shared allocation-run history. */
export function AllocationsRunsTabSlot() {
  return <RunsTab />
}
