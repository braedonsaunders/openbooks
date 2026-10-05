import 'server-only'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Badge, Button } from '@openbooks/ui'
import { db } from '@openbooks/engine/platform/database'
import { listBenefitsProgramCatalog, type BenefitsProgramWorkspace } from '@openbooks/engine/hrm/benefits'
import { PreparedPagedTable } from '../../../../components/prepared-paged-table'
import { Pagination } from '../../../../components/pagination'
import { AuditTrailPanel } from '../../../../components/audit-trail-panel'
import { can, type Authz } from '../../../../lib/authz'
import { benefitPlanPresentation, BENEFIT_PLANS_ENTITY } from '../../../../lib/setup/hrm-benefits'
import { benefitEntitlementPresentation } from '../../../../lib/setup/benefit-entitlements'
import { SETUP_ENTITY_BY_KEY, setupChildEntities } from '../../../../lib/setup/registry'
import { getMoneyFormatter } from '../../../../lib/money-server'
import { SetupEntitySection } from '../../admin/setup/[entity]/SetupEntitySection'

/** Program work areas share the native configuration record and its single drawer shell. */
export async function ProgramWorkspace({ authz, workspace, sp }: {
  authz: Authz; workspace: BenefitsProgramWorkspace; sp: Record<string, string | undefined>
}) {
  const t = await getTranslations('hrm')
  const ta = await getTranslations('admin.setup')
  const program = workspace.program
  if (program.nativeKind === 'insured' && sp.setupTab === 'recovery') {
    const params = new URLSearchParams(Object.entries(sp).filter((entry): entry is [string, string] => entry[1] !== undefined))
    params.set('setupTab', 'benefit-recovery-sources')
    redirect(`/hrm/benefits?${params}`)
  }
  const canManage = can(authz, 'hrm.benefits.manage')
  const { money } = await getMoneyFormatter(authz.user.orgId)
  const catalog = []
  for (let offset = 0; ; offset += 500) {
    const batch = await listBenefitsProgramCatalog(db, authz.user.orgId, authz.user.id, { includeInternal:true, limit:500, offset })
    catalog.push(...batch)
    if (batch.length < 500) break
  }
  const children = catalog.filter(child => child.parentProgramIds.includes(program.id))
  const participants = <div className="space-y-4">
    <div className="flex items-start justify-between gap-3"><p className="text-sm text-slate-500">{t(program.nativeKind === 'insured' ? 'programWorkspace.participantsHint' : 'programWorkspace.entitlementParticipantsHint')}</p>
      {canManage && (program.nativeKind === 'insured' || workspace.nativeRecord.system_key === 'vacation') ? <Button asChild size="sm" variant="outline"><Link href={program.nativeKind === 'insured' ? `/hrm/benefits?view=employees&enrollment=new&benefitProgram=${program.id}` : `/hrm/benefits?view=employees&vacationTerms=new&benefitProgram=${program.id}`}>{t('programWorkspace.assignEmployee')}</Link></Button> : null}
    </div>
    <PreparedPagedTable source="hrm_benefit_program_participants_page" rows={workspace.participants.map(person => ({
      id: person.id, searchText: `${person.employeeName} ${person.status}`, cells: [
        <Link key="employee" href={`/entities/employees?party=${person.employeePartyId}&partyTab=benefits`} className="font-medium text-teal-700 hover:underline">{person.employeeName}</Link>,
        <span key="dates" className="tabular-nums">{person.effectiveFrom} – {person.effectiveTo ?? '…'}</span>,
        <Badge key="status">{t.has(`benefits.statusNames.${person.status}`) ? t(`benefits.statusNames.${person.status}`) : t.has(`programWorkspace.participantStatus.${person.status}`) ? t(`programWorkspace.participantStatus.${person.status}`) : person.status}</Badge>,
        <Link key="assignment" href={person.nativeKind === 'enrollment' ? `/hrm/benefits?view=employees&enrollmentConfig=${person.id}` : `/hrm/benefits?view=employees&vacationTerms=${person.id}`} className="text-teal-700 hover:underline">{t('programWorkspace.openAssignment')}</Link>,
      ],
    }))} columns={[{key:'employee',header:t('benefits.columns.employee')},{key:'effective',header:t('portfolio.columns.effective')},{key:'status',header:t('portfolio.columns.status')},{key:'assignment',header:t('programWorkspace.assignment')}]} empty={<p>{t('programWorkspace.participantsEmpty')}</p>} />
    <Pagination basePath="/hrm/benefits" currentParams={{...sp,setupTab:'participants'}} pageParamKey="participantsPage" total={null} page={Number(sp.participantsPage ?? '1')} perPage={100} loadedCount={workspace.participants.length} hasMore={workspace.hasMoreParticipants} />
  </div>
  function activity(delivery: boolean) {
    const rows = delivery ? workspace.activity.filter(item => item.payRunDocumentId !== null) : workspace.activity
    return <div className="space-y-4"><p className="text-sm text-slate-500">{t(program.nativeKind === 'insured' ? 'programWorkspace.planDeliveryHint' : 'programWorkspace.entitlementDeliveryHint')}</p>
      <PreparedPagedTable source="hrm_benefit_program_activity_page" rows={rows.map(item => ({ id:item.id,searchText:`${item.employeeName} ${item.onDate} ${item.status}`,cells:[
        <Link key="employee" href={`/entities/employees?party=${item.employeePartyId}`} className="font-medium text-teal-700 hover:underline">{item.employeeName}</Link>,
        <span key="date" className="tabular-nums">{item.onDate}</span>,
        <span key="amount" className="tabular-nums">{item.currency ? money(item.amount,{currency:item.currency}) : `${item.amount} ${t(`programWorkspace.units.${item.unit}`)}`}</span>,
        <Badge key="status">{item.payrollProcessed ? t('programWorkspace.processedPayroll') : item.payRunDocumentId ? t('programWorkspace.queuedPayroll') : t.has(`programWorkspace.activityStatus.${item.status}`) ? t(`programWorkspace.activityStatus.${item.status}`) : item.status}</Badge>,
        item.payRunDocumentId ? <Link key="run" href={`/payroll/runs/${item.payRunDocumentId}`} className="text-teal-700 hover:underline">{t('programWorkspace.openPayRun')}</Link> : '—',
      ] }))} columns={[{key:'employee',header:t('benefits.columns.employee')},{key:'date',header:t('programWorkspace.date')},{key:'amount',header:t('portfolio.columns.value'),align:'right'},{key:'status',header:t('portfolio.columns.status')},{key:'run',header:t('programWorkspace.payRun')}]} empty={<p>{t('programWorkspace.activityEmpty')}</p>} />
      <Pagination basePath="/hrm/benefits" currentParams={{...sp,setupTab:delivery?'delivery':'activity'}} pageParamKey="activityPage" total={null} page={Number(sp.activityPage ?? '1')} perPage={100} loadedCount={rows.length} showRange={!delivery} hasMore={workspace.hasMoreActivity} />
    </div>
  }
  const nativeEntity = program.nativeKind === 'insured'
    ? program.type === 'health' || program.type === 'retirement' ? benefitPlanPresentation(program.type, false) : BENEFIT_PLANS_ENTITY
    : program.type === 'recovery' ? {...SETUP_ENTITY_BY_KEY.get('entitlement-plans')!,singularTitleKey:'benefitBuilder.recovery.title'} : benefitEntitlementPresentation(SETUP_ENTITY_BY_KEY.get('entitlement-plans')!)
  const tabs = [
    {key:'participants',label:t('programWorkspace.participants'),content:participants},
    {key:'activity',label:t('programWorkspace.activity'),content:activity(false)},
    {key:'delivery',label:t('programWorkspace.delivery'),content:activity(true)},
    {key:'history',label:t('programWorkspace.history'),content:<AuditTrailPanel table={program.nativeKind === 'insured' ? 'hrm_benefit_plans' : 'entitlement_plans'} recordId={program.id} />},
  ]
  const recoveryBanks = children.length ? <section className="space-y-3" aria-label={t('programWorkspace.recoveryBanks')}>
    <h2 className="text-sm font-semibold">{t('programWorkspace.recoveryBanks')}</h2>
    <p className="text-sm text-slate-500">{t('programWorkspace.recoveryHint')}</p>
    {children.map(child => <p key={child.id}><Link href={`/hrm/benefits?view=programs&program=${child.id}`} className="font-medium text-teal-700 hover:underline">{child.name}</Link></p>)}
  </section> : undefined
  return <SetupEntitySection entity={{...nativeEntity,formDescriptionKey:undefined,recordChildren:(nativeEntity.recordChildren ?? setupChildEntities(nativeEntity.key)).filter(child => child.key !== 'payroll-vacation-terms'),creationSteps:undefined,readOnly:!canManage}} orgId={authz.user.orgId} actorId={authz.user.id}
    searchParams={sp} basePath="/hrm/benefits" rowParam="program" drawerOnly hideHeader canManage
    visibleRowIds={new Set([program.id])} allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
    groupRuleTabs detailsLabel={t('programWorkspace.rules')} recordTitle={program.name} additionalRecordTabs={tabs}
    ruleDetailsLabel={ta('benefitBuilder.offer')} childTabIntroductions={{'benefit-recovery-sources':recoveryBanks}}
    mutationBasePath="/api/hrm/benefit-plan-configuration" />
}
