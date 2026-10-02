import { SetupEntitySection } from '../../admin/setup/[entity]/SetupEntitySection'
import { BENEFIT_PLANS_ENTITY, benefitPlanPresentation } from '../../../../lib/setup/hrm-benefits'
import { requirePermission, can } from '../../../../lib/authz'
import { BENEFIT_ENROLLMENT_CONFIGURATION_ENTITY } from '../../../../lib/setup/hrm-benefit-contributions'
import { BenefitChangeDialog, type BenefitChangeDialogStrings } from '../../me/islands'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { listBenefitPlans, listEnrollments, listEnrollmentPlanOptions, listEnrollmentContributionTerms } from '@openbooks/engine/hrm/benefits'
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
  if (sp.plan === 'new' && sp.kind !== 'health' && sp.kind !== 'retirement') redirect('/hrm/benefits?view=programs&program=new')
  const data = await loadBenefitsPage(sp)
  const planId = sp.plan
  const enrollmentId = sp.enrollmentConfig
  const changeEnrollmentId = sp.changeEnrollment
  const authz = planId || enrollmentId || changeEnrollmentId ? await requirePermission(planId === 'new' || changeEnrollmentId ? 'hrm.benefits.manage' : 'hrm.benefits.read') : null
  const enrollments = authz && (enrollmentId || changeEnrollmentId) ? await listEnrollments(db, authz.user.orgId, authz.user.id) : []
  if (enrollmentId && (!isUuid(enrollmentId) || !enrollments.some((enrollment) => enrollment.id === enrollmentId))) notFound()
  if (changeEnrollmentId && (!isUuid(changeEnrollmentId) || !enrollments.some((enrollment) => enrollment.id === changeEnrollmentId && enrollment.status === 'active'))) notFound()
  const selectedEnrollment = enrollments.find((enrollment) => enrollment.id === enrollmentId)
  const t = await getTranslations('hrm')
  let changeDialog: BenefitChangeDialogStrings | null = null
  if (authz && changeEnrollmentId) {
    const [terms, options, context] = await Promise.all([
      listEnrollmentContributionTerms({ orgId: authz.user.orgId, actorId: authz.user.id, enrollmentId: changeEnrollmentId }),
      listEnrollmentPlanOptions(db, authz.user.orgId, authz.user.id),
      db.execute<{ plan_id: string; class_key: string | null; match_eligible: boolean | null }>(sql`select plan_id,class_key,match_eligible from hrm_benefit_enrollments where org_id=${authz.user.orgId} and id=${changeEnrollmentId}`),
    ])
    const current = context.rows[0]
    const plan = options.find((option) => option.value === current?.plan_id)
    if (!current || !plan) notFound()
    changeDialog = {
      enrollmentId: changeEnrollmentId, planName: plan.label,
      title: t('me.benefits.changeTitle'), description: t('me.benefits.changeDescription'),
      classKey: current.class_key, matchEligible: current.match_eligible,
      classes: plan.classes, contributionRules: plan.contributionRules,
      contributionTerms: terms.map((term) => ({ ruleId: String(term.ruleId), electionMode: term.electionMode as 'fixed' | 'follows_policy', electedRate: term.electedRate == null ? null : String(term.electedRate), declaredPeriodsPerYear: term.declaredPeriodsPerYear == null ? null : Number(term.declaredPeriodsPerYear) })),
      dateLabel: t('me.benefits.fromLabel'), reasonLabel: t('me.profile.reason'), reasonPlaceholder: t('me.benefits.changeReasonPlaceholder'),
      submitLabel: t('me.benefits.changeSubmit'), cancelLabel: t('me.profile.cancel'), submitFailed: t('me.benefits.changeFailed'),
    }
  }
  const plans = authz ? await listBenefitPlans(db, authz.user.orgId, authz.user.id) : []
  const planKind = plans.find((plan) => plan.id === planId)?.kind
  const presentationKind = planId === 'new' ? sp.kind : planKind === 'retirement' ? 'retirement' : 'health'
  if (planId && planId !== 'new' && (!isUuid(planId) || !plans.some((plan) => plan.id === planId))) notFound()
  return <>
    <ModuleView spec={benefitsSpec(data)} data={data} searchParams={sp} trusted />
    {changeDialog ? <BenefitChangeDialog dialog={changeDialog} mode="manage" closeHref="/hrm/benefits?view=enrolments" /> : null}
    {authz && enrollmentId ? <SetupEntitySection
      entity={{ ...BENEFIT_ENROLLMENT_CONFIGURATION_ENTITY, readOnly: true, recordLinks: selectedEnrollment?.status === 'active' && can(authz, 'hrm.benefits.manage') ? [{ href: `/hrm/benefits?view=enrolments&changeEnrollment=${encodeURIComponent(enrollmentId)}`, label: t('me.benefits.changeSubmit') }] : [] }}
      orgId={authz.user.orgId} actorId={authz.user.id} searchParams={sp} basePath="/hrm/benefits"
      canManage allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
      visibleRowIds={new Set(enrollments.map((enrollment) => enrollment.id))}
      rowParam="enrollmentConfig" drawerOnly hideHeader mutationBasePath="/api/hrm/benefit-plan-configuration"
    /> : null}
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
