import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, grid, heading, textBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { getManufacturingPolicies, type ManufacturingPolicies } from '@openbooks/engine/src/manufacturing/policies.ts'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { requirePermission, guardRootSubsidiaryScope } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { notFound } from 'next/navigation'

export interface ManufacturingSetupData {
  title: string
  description: string
  policies: ManufacturingPolicies
}

export async function loadManufacturingSetup(): Promise<ManufacturingSetupData> {
  const authz = await requirePermission('admin.setup.manage')
  if (await guardRootSubsidiaryScope(authz)) notFound()
  await requireFeatureEnabled(authz.user.orgId, 'manufacturing')
  const t = await getTranslations('admin')
  const policies = await withOrgTransaction(authz.user.orgId, () => getManufacturingPolicies(db, authz.user.orgId))
  return {
    title: t('setup.entities.manufacturing-policies.title'),
    description: t('setup.entities.manufacturing-policies.description'),
    policies,
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
