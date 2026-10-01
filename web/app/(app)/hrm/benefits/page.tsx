import { SetupEntitySection } from '../../admin/setup/[entity]/SetupEntitySection'
import { BENEFIT_PLANS_ENTITY } from '../../../../lib/setup/hrm-benefits'
import { requirePermission, can } from '../../../../lib/authz'
import { listBenefitPlans } from '@openbooks/engine/hrm/benefits'
import { db } from '@openbooks/engine/platform/database'
import { isUuid } from '../../../../lib/list-params'
import { notFound, redirect } from 'next/navigation'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { benefitsSpec, benefitsTitle, loadBenefitsPage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await benefitsTitle() }
}

/** Each Benefits destination renders one operational list under the shared header. */
export default async function BenefitsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  if (sp.view === 'windows') {
    const params = new URLSearchParams(Object.entries(sp).filter((entry): entry is [string, string] => entry[1] !== undefined))
    params.set('view', 'enrolments')
    if (!sp.window) params.set('windows', '1')
    redirect(`/hrm/benefits?${params}`)
  }
  const data = await loadBenefitsPage(sp)
  const planId = sp.plan
  const authz = planId ? await requirePermission(planId === 'new' ? 'hrm.benefits.manage' : 'hrm.benefits.read') : null
  const plans = authz ? await listBenefitPlans(db, authz.user.orgId, authz.user.id) : []
  if (planId && planId !== 'new' && (!isUuid(planId) || !plans.some((plan) => plan.id === planId))) notFound()
  return <>
    <ModuleView spec={benefitsSpec(data)} data={data} searchParams={sp} trusted />
    {authz && planId ? <SetupEntitySection
      entity={planId === 'new' && (sp.kind === 'health' || sp.kind === 'retirement')
        ? { ...BENEFIT_PLANS_ENTITY, readOnly: !can(authz, 'hrm.benefits.manage'), fields: BENEFIT_PLANS_ENTITY.fields.map((field) => field.key === 'kind' ? { ...field, defaultValue: sp.kind } : field) }
        : { ...BENEFIT_PLANS_ENTITY, readOnly: !can(authz, 'hrm.benefits.manage') }}
      orgId={authz.user.orgId} actorId={authz.user.id}
      searchParams={sp} basePath="/hrm/benefits"
      canManage={planId !== 'new' || can(authz, 'hrm.benefits.manage')}
      allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
      visibleRowIds={new Set(plans.map((plan) => plan.id))}
      rowParam="plan" drawerOnly hideHeader mutationBasePath="/api/hrm/benefit-plan-configuration"
    /> : null}
  </>
}
