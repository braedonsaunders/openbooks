import { SetupEntitySection } from '../../admin/setup/[entity]/SetupEntitySection'
import { benefitPlanPresentation } from '../../../../lib/setup/hrm-benefits'
import { benefitEntitlementPresentation } from '../../../../lib/setup/benefit-entitlements'
import { SETUP_ENTITY_BY_KEY } from '../../../../lib/setup/registry'
import { requirePermission, can } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { EmployeeBenefitsWorkspace } from './EmployeeBenefitsWorkspace'
import { ProgramWorkspace } from './ProgramWorkspace'
import { getBenefitsProgramWorkspace, BenefitsError, type BenefitsProgramWorkspace } from '@openbooks/engine/hrm/benefits'
import { db } from '@openbooks/engine/platform/database'
import { isUuid } from '../../../../lib/list-params'
import { notFound } from 'next/navigation'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { benefitsSpec, benefitsTitle, loadBenefitsPage } from './view'

export const dynamic = 'force-dynamic'
export async function generateMetadata() { return { title: await benefitsTitle() } }

/** The program catalog, employee relationships and delivery each have one native workspace. */
export default async function BenefitsPage({ searchParams }: {searchParams: Promise<Record<string, string | undefined>>}) {
  const sp = await searchParams
  if (sp.view && !['overview','programs','employees','delivery'].includes(sp.view)) notFound()
  if (sp.view === 'employees') return <EmployeeBenefitsWorkspace sp={sp} />
  const nativeCreate = sp.plan === 'new' || sp.program === 'new' && sp.kind === 'time_off'
  if (sp.plan && (sp.plan !== 'new' || sp.kind !== 'health' && sp.kind !== 'retirement')) notFound()
  const authz = await requirePermission(nativeCreate ? 'hrm.benefits.manage' : 'hrm.benefits.read')
  await requireFeatureEnabled(authz.user.orgId,'hrm')
  let workspace: BenefitsProgramWorkspace | null = null
  let programRefusal: string | null = null
  if (sp.program && sp.program !== 'new') {
    if (!isUuid(sp.program)) notFound()
    const pageNumber = (key: string) => { const value=sp[key]; if (value && !/^[1-9]\d*$/.test(value)) notFound(); const parsed=Number(value ?? '1'); if (!Number.isSafeInteger(parsed) || !Number.isSafeInteger((parsed-1)*100)) notFound(); return parsed }
    try { workspace = await getBenefitsProgramWorkspace(db, authz.user.orgId, authz.user.id, sp.program, {participantOffset:(pageNumber('participantsPage')-1)*100,activityOffset:(pageNumber('activityPage')-1)*100}) }
    catch (error) { if (error instanceof BenefitsError && error.code === 'NOT_FOUND') notFound(); if (!(error instanceof BenefitsError)) throw error; programRefusal=error.message }
  }
  // Time-off entitlements accrue through Payroll; a switched-off Payroll names that remedy.
  if (workspace?.program.nativeKind === 'entitlement' || sp.kind === 'time_off') await requireFeatureEnabled(authz.user.orgId,'payroll')
  const data = await loadBenefitsPage(sp)
  if (programRefusal) { data.refusal={title:data.title,message:programRefusal}; data.hasContent=false }
  return <>
    <ModuleView spec={benefitsSpec(data)} data={data} searchParams={sp} trusted />
    {workspace && workspace.program.nativeKind !== 'employer' ? <ProgramWorkspace authz={authz} workspace={workspace} sp={sp} /> : null}
    {nativeCreate ? <SetupEntitySection
      entity={sp.kind === 'time_off' ? benefitEntitlementPresentation(SETUP_ENTITY_BY_KEY.get('entitlement-plans')!,true) : benefitPlanPresentation(sp.kind as 'health'|'retirement',true)}
      orgId={authz.user.orgId} actorId={authz.user.id} searchParams={sp} basePath="/hrm/benefits"
      canManage={can(authz,'hrm.benefits.manage')} allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
      rowParam={sp.kind === 'time_off' ? 'program':'plan'} drawerOnly hideHeader mutationBasePath="/api/hrm/benefit-plan-configuration" /> : null}
  </>
}
