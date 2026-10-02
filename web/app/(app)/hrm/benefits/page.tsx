import { SetupEntitySection } from '../../admin/setup/[entity]/SetupEntitySection'
import { BENEFIT_PLANS_ENTITY, benefitPlanPresentation } from '../../../../lib/setup/hrm-benefits'
import { requirePermission, can } from '../../../../lib/authz'
import { loadBenefitEnrollmentRecord } from '../../../../lib/hrm/benefit-enrollment-record'
import { PolicyWorkspace } from './PolicyWorkspace'
import { EnrollmentDrawer } from './EnrollmentDrawer'
import { getTranslations } from 'next-intl/server'
import { listBenefitPlans, listEnrollments } from '@openbooks/engine/hrm/benefits'
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
  if (sp.view === 'policies') return <PolicyWorkspace sp={sp} />
  if (sp.view === 'windows') {
    const params = new URLSearchParams(Object.entries(sp).filter((entry): entry is [string, string] => entry[1] !== undefined))
    params.set('view', 'enrolments')
    if (!sp.window) params.set('windows', '1')
    redirect(`/hrm/benefits?${params}`)
  }
  if (sp.plan === 'new' && sp.kind !== 'health' && sp.kind !== 'retirement') redirect('/hrm/benefits?view=programs&program=new')
  const data = await loadBenefitsPage(sp)
  const planId = sp.plan
  const enrollmentId = sp.enrollmentConfig
  const authz = planId || enrollmentId ? await requirePermission(planId === 'new' ? 'hrm.benefits.manage' : 'hrm.benefits.read') : null
  const enrollments = authz && enrollmentId ? await listEnrollments(db, authz.user.orgId, authz.user.id) : []
  const selectedEnrollment = enrollments.find(enrollment => enrollment.id === enrollmentId)
  if (enrollmentId && (!isUuid(enrollmentId) || !selectedEnrollment)) notFound()
  const t = await getTranslations('hrm')
  const loadedEnrollment = authz && selectedEnrollment ? await loadBenefitEnrollmentRecord(authz, selectedEnrollment) : null
  const plans = authz ? await listBenefitPlans(db, authz.user.orgId, authz.user.id) : []
  const planKind = plans.find((plan) => plan.id === planId)?.kind
  const presentationKind = planId === 'new' ? sp.kind : planKind === 'retirement' ? 'retirement' : 'health'
  if (planId && planId !== 'new' && (!isUuid(planId) || !plans.some((plan) => plan.id === planId))) notFound()
  return <>
    <ModuleView spec={benefitsSpec(data)} data={data} searchParams={sp} trusted />
    {authz && loadedEnrollment ? <EnrollmentDrawer key={loadedEnrollment.record.id} record={loadedEnrollment.record} canManage={can(authz, 'hrm.benefits.manage')} canChange={loadedEnrollment.canChange} closeHref="/hrm/benefits?view=enrolments" /> : null}
    {authz && planId ? <SetupEntitySection
      entity={presentationKind === 'health' || presentationKind === 'retirement'
        ? { ...benefitPlanPresentation(presentationKind, planId === 'new'), ...(planId === 'new' ? {} : { creationSteps: undefined, recordLinks: can(authz, 'hrm.benefits.manage') ? [{ href: '/admin/flows', label: t('portfolio.configureApprovals') }] : [] }), readOnly: !can(authz, 'hrm.benefits.manage') }
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
