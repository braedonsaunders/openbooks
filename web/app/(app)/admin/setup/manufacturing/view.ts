import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, grid, heading, textBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { getManufacturingPolicies, type ManufacturingPolicies } from '@openbooks/engine/src/manufacturing/policies.ts'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { requirePermission, guardRootSubsidiaryScope } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { notFound } from 'next/navigation'
import { SETUP_ENTITY_BY_KEY } from '../../../../../lib/setup/registry'
import { pickString } from '../../../../../lib/list-params'

const ENTITY_TABS = [
  { key: 'workflows', entityKey: 'operating-profiles', labelKey: 'setup.entities.operating-profiles.title' },
  { key: 'departments', entityKey: 'operating-profile-scopes', labelKey: 'setup.entities.operating-profile-scopes.title' },
  { key: 'calendars', entityKey: 'work-calendars', labelKey: 'setup.entities.work-calendars.title' },
  { key: 'scrap-reasons', entityKey: 'mfg-scrap-reasons', labelKey: 'setup.entities.mfg-scrap-reasons.title' },
  { key: 'item-policies', entityKey: 'mfg-item-policies', labelKey: 'setup.entities.mfg-item-policies.title' },
  { key: 'inspection-plans', entityKey: 'inspection-plans', labelKey: 'setup.entities.inspection-plans.title' },
] as const

type ManufacturingTab = 'start' | 'policies' | (typeof ENTITY_TABS)[number]['key']

export interface ManufacturingSetupData {
  title: string
  description: string
  policies: ManufacturingPolicies
  tab: ManufacturingTab
  entityKey: string | null
  currentParams: Record<string, string | string[] | undefined>
  tabs: { href: string; label: string; active: boolean }[]
}

export async function loadManufacturingSetup(
  sp: Record<string, string | string[] | undefined> = {},
): Promise<ManufacturingSetupData> {
  const authz = await requirePermission('admin.setup.manage')
  if (await guardRootSubsidiaryScope(authz)) notFound()
  await requireFeatureEnabled(authz.user.orgId, 'manufacturing')
  const t = await getTranslations('admin')
  const availableTabs = ENTITY_TABS.filter(({ entityKey }) => SETUP_ENTITY_BY_KEY.has(entityKey))
  const requested = pickString(sp.tab)
  const tab: ManufacturingTab =
    requested === 'start' || requested === 'policies' || availableTabs.some((candidate) => candidate.key === requested)
      ? requested as ManufacturingTab
      : 'start'
  const m = await getTranslations('manufacturing')
  const tabLabels = [
    { key: 'start' as const, label: m('cockpit.setup') },
    { key: 'policies' as const, label: t('setup.entities.manufacturing-policies.title') },
    ...availableTabs.map(({ key, labelKey }) => ({ key, label: t(labelKey) })),
  ]
  const policies = await withOrgTransaction(authz.user.orgId, () => getManufacturingPolicies(db, authz.user.orgId))
  return {
    title: t('setup.entities.manufacturing-policies.title'),
    description: t('setup.entities.manufacturing-policies.description'),
    policies,
    tab,
    entityKey: ENTITY_TABS.find((candidate) => candidate.key === tab)?.entityKey ?? null,
    currentParams: sp,
    tabs: tabLabels.map(({ key, label }) => ({
      href: `/admin/setup/manufacturing?tab=${key}`,
      label,
      active: key === tab,
    })),
  }
}

export function manufacturingPoliciesSpec(data: ManufacturingSetupData): PageSpec {
  return page({
    route: '/admin/setup/manufacturing',
    layout: 'bare',
    header: [],
    body: [grid('space-y-1', [
      heading(2, data.title, 'text-base font-semibold text-slate-900 dark:text-slate-100'),
      textBlock(data.description, { size: 'sm', className: 'text-slate-500 dark:text-slate-400' }),
    ])],
  })
}
