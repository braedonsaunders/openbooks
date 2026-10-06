import 'server-only'
import { AuditTrailPanel } from '@/components/audit-trail-panel'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { CompensationPackageUnavailableError, getCompensationPackage, listCompensationPackages } from '@openbooks/engine/payroll/compensation-packages'
import { Alert } from '@openbooks/ui'
import { requireFeatureEnabled } from '@/lib/feature-gates'
import { can, requirePermission } from '@/lib/authz'
import { pickString } from '@/lib/list-params'
import { PAYROLL_COMPENSATION_PACKAGES_ENTITY, packageAssignmentPresentation, packageVersionPresentation } from '@/lib/setup/payroll-compensation-packages'
import { SetupEntitySection } from '../[entity]/SetupEntitySection'
import { CompensationPackageActions, CompensationPackagePreview, PackageVersionPicker } from './CompensationPackageActions'

/** Benefits ProgramWorkspace is the exemplar: one native record hosts native child work areas. */
export async function CompensationPackagesSection({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const authz = await requirePermission('payroll.read'), t = await getTranslations('admin.setup')
  const actor = { orgId: authz.user.orgId, actorId: authz.user.id }
  await requireFeatureEnabled(actor.orgId, 'compensationPackages')
  let packages: Awaited<ReturnType<typeof listCompensationPackages>>
  try { packages = await listCompensationPackages(actor) }
  catch (error) {
    if (error instanceof CompensationPackageUnavailableError) return <Alert>{t('compensationPackages.serverUpgrade')}</Alert>
    throw error
  }
  const selected = pickString(sp.package)
  if (selected && selected !== 'new' && !packages.some(pack => pack.id === selected)) notFound()
  const workspace = selected && selected !== 'new' ? await getCompensationPackage({ ...actor, packageId: selected }) : null
  const pack = workspace?.package
  const manage = can(authz, 'payroll.manage'), approve = can(authz, 'hrm.compensation.approve')
  const tabs = []
  if (pack && workspace) {
    const version = workspace.versions.find(item => item.id === pickString(sp.packageVersionsRow))
    const assignment = workspace.assignments.find(item => item.id === pickString(sp.packageAssignmentsRow))
    const approved = workspace.versions.filter(item => item.status === 'approved')
    const assignmentVersion = workspace.versions.find(item => item.id === (assignment?.versionId ?? pickString(sp.assignmentVersion)) && item.status === 'approved')
    tabs.push({ key: 'history', label: t('compensationPackages.history'), content: <AuditTrailPanel table="payroll_compensation_packages" recordId={pack.id} /> })
    const versionEntity = packageVersionPresentation(pack, actor.orgId, !version)
    const assignmentEntity = packageAssignmentPresentation(pack, assignmentVersion)
    const base = { orgId: actor.orgId, actorId: actor.actorId, searchParams: sp, basePath: '/admin/setup/payroll', canManage: true, allowedSubsidiaryIds: authz.allowedSubsidiaryIds, parent: { recordKey: 'payroll-compensation-packages', value: pack.id }, stacked: true }
    tabs.push({ key: 'versions', label: t('compensationPackages.versions'), content: <SetupEntitySection {...base} entity={{ ...versionEntity, readOnly: !manage || Boolean(version && version.status !== 'draft'), allowCreate: manage && pack.status === 'active' }} rowParam="packageVersionsRow" paramPrefix="packageVersions" visibleRowIds={new Set(workspace.versions.map(item => item.id))}
      additionalRecordTabs={version ? [{ key: 'review', label: t('compensationPackages.review'), content: <CompensationPackageActions packageId={pack.id} version={version} canManage={manage} canApprove={approve} /> }, { key: 'preview', label: t('compensationPackages.preview'), content: <CompensationPackagePreview packageId={pack.id} version={version} /> }, { key: 'history', label: t('compensationPackages.history'), content: <AuditTrailPanel table="payroll_compensation_versions" recordId={version.id} /> }] : []} /> })
    tabs.push({ key: 'assignments', label: t('compensationPackages.assignments'), content: <div className="space-y-4">
      <PackageVersionPicker versions={approved} value={assignmentVersion?.id} />
      {!assignmentVersion && manage ? <p className="text-sm text-slate-500">{t('compensationPackages.chooseVersionHint')}</p> : null}
      <SetupEntitySection {...base} entity={{ ...assignmentEntity, readOnly: !manage || Boolean(assignment && assignment.status !== 'draft'), allowCreate: manage && pack.status === 'active' && Boolean(assignmentVersion), fields: assignmentEntity.fields.map(field => field.key === 'versionId' ? { ...field, hidden: true, defaultValue: assignmentVersion?.id } : field.key === 'subsidiaryId' ? { ...field, defaultValue: pack.subsidiaryId } : field) }} rowParam="packageAssignmentsRow" paramPrefix="packageAssignments" visibleRowIds={new Set(workspace.assignments.map(item => item.id))}
        additionalRecordTabs={assignment ? [{ key: 'review', label: t('compensationPackages.review'), content: <CompensationPackageActions packageId={pack.id} assignment={assignment} canManage={manage} canApprove={approve} /> }, { key: 'history', label: t('compensationPackages.history'), content: <AuditTrailPanel table="payroll_compensation_assignments" recordId={assignment.id} /> }] : []} />
    </div> })
  }
  return <SetupEntitySection entity={{ ...PAYROLL_COMPENSATION_PACKAGES_ENTITY, recordChildren: [], readOnly: !manage || pack?.status === 'retired' }} orgId={actor.orgId} actorId={actor.actorId} searchParams={sp} basePath="/admin/setup/payroll" rowParam="package" canManage allowedSubsidiaryIds={authz.allowedSubsidiaryIds} visibleRowIds={new Set(packages.map(item => item.id))} recordTitle={pack?.name} additionalRecordTabs={tabs} />
}
