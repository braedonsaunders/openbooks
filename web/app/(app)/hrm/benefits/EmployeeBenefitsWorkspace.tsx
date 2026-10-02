import 'server-only'
import Link from 'next/link'
import { Alert, Badge, Button, PageHeader } from '@openbooks/ui'
import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import { BenefitsError, listEnrollmentPlanOptions, listEnrollmentWindows, listEnrollments } from '@openbooks/engine/hrm/benefits'
import { ListPageLayout } from '../../../../components/page-layout'
import { PreparedPagedTable } from '../../../../components/prepared-paged-table'
import { ListFilterSelect } from '../../../../components/list-filter-select'
import { requirePermission, can } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { subsidiaryVisibleFilter } from '../../../../lib/subsidiaries'
import { listScopedDepartmentOptions } from '../../../../lib/scoped-options'
import { loadEmployeeBenefitAssignments } from '../../../../lib/hrm/employee-benefits-workspace'
import { benefitContributionLabels } from '../../../../lib/hrm/benefit-contribution-labels'
import { loadBenefitEnrollmentRecord } from '../../../../lib/hrm/benefit-enrollment-record'
import { EmployeeBenefitAssignmentError, type EmployeeBenefitPolicyRow } from '../../../../lib/hrm/employee-benefits-types'
import type { BenefitsWindowRow, WindowDrawerData } from '../../../../lib/hrm/benefits'
import { SetupDrawer } from '../../admin/setup/[entity]/SetupDrawer'
import { PAYROLL_VACATION_TERMS_ENTITY } from '../../../../lib/setup/payroll-vacation-terms'
import { BenefitElectDialog, type BenefitElectDialogStrings } from '../../me/islands'
import { EnrollmentDrawer } from './EnrollmentDrawer'
import { WindowsManagerDrawer } from './WindowsManagerDrawer'
import { WindowDialog } from './WindowDialog'
import { WindowDrawer } from './WindowDrawer'

/** A single native list presents program participation across existing employee records. */
export async function EmployeeBenefitsWorkspace({ sp }: { sp: Record<string, string | undefined> }) {
  const authz = await requirePermission('hrm.benefits.read')
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  for (const key of ['employee', 'benefitProgram', 'enrollmentConfig'] as const) if (sp[key] && !isUuid(sp[key]!)) notFound()
  if (sp.window && sp.window !== 'new' && !isUuid(sp.window)) notFound()
  if (sp.vacationTerms && sp.vacationTerms !== 'new' && !isUuid(sp.vacationTerms)) notFound()
  const [t, hrm, admin] = await Promise.all([getTranslations('hrm.employeeBenefits'), getTranslations('hrm'), getTranslations('admin')])
  const canManage = can(authz, 'hrm.benefits.manage')
  return withOrgTransaction(authz.user.orgId, async () => {
    const { assignments, programs } = await loadEmployeeBenefitAssignments(authz, sp.employee)
    if (sp.benefitProgram && !programs.some(program => program.value === sp.benefitProgram)) notFound()
    const filtered = sp.benefitProgram ? assignments.filter(row => row.programId === sp.benefitProgram) : assignments
    const enrollmentAssignment = sp.enrollmentConfig ? assignments.find(row => row.nativeKind === 'enrollment' && row.nativeId === sp.enrollmentConfig) : null
    const creatingVacation = sp.vacationTerms === 'new'
    if (creatingVacation && (!canManage || !sp.benefitProgram)) notFound()
    const vacationAssignment = sp.vacationTerms && !creatingVacation ? assignments.find(row => row.nativeKind === 'vacation_terms' && row.nativeId === sp.vacationTerms) : null
    if (sp.enrollmentConfig && !enrollmentAssignment || sp.vacationTerms && !creatingVacation && !vacationAssignment) notFound()
    const enrollment = enrollmentAssignment ? (await listEnrollments(db, authz.user.orgId, authz.user.id, { employmentId: enrollmentAssignment.employmentId })).find(row => row.id === enrollmentAssignment.nativeId) : null
    if (enrollmentAssignment && !enrollment) notFound()
    const loadedEnrollment = enrollment ? await loadBenefitEnrollmentRecord(authz, enrollment) : null
    const vacation = vacationAssignment ? (await db.execute<EmployeeBenefitPolicyRow>(sql`select id,plan_id,employment_id,method,percent_floor::text,annual_days_floor::text,effective_from::text,effective_to::text,reason
      from payroll_vacation_terms where org_id=${authz.user.orgId} and id=${vacationAssignment.nativeId} and employment_id=${vacationAssignment.employmentId}`)).rows[0] : null
    if (vacationAssignment && !vacation) notFound()
    if (creatingVacation) {
      await requireFeatureEnabled(authz.user.orgId, 'payroll')
      const governing = (await db.execute(sql`select id from entitlement_plans where org_id=${authz.user.orgId} and id=${sp.benefitProgram}::uuid and system_key='vacation'`)).rows
      if (governing.length !== 1) notFound()
    }
    const currentParams = { view: 'employees', ...(sp.employee ? { employee: sp.employee } : {}), ...(sp.benefitProgram ? { benefitProgram: sp.benefitProgram } : {}) }
    const closeHref = `/hrm/benefits?${new URLSearchParams(currentParams)}`
    const windowsHref = `${closeHref}&windows=1`
    const needsWindows = sp.windows === '1' || !!sp.window || sp.enrollment === 'new'
    const windows = needsWindows ? await listEnrollmentWindows(db, authz.user.orgId, authz.user.id) : []
    const windowRows: BenefitsWindowRow[] = windows.map(window => ({ ...window,
      kindLabel: hrm(`benefits.windowKinds.${window.kind}`), statusLabel: hrm(`benefits.statusNames.${window.status}`),
      statusVariant: window.status === 'open' ? 'success' : window.status === 'draft' ? 'warning' : 'outline',
      rangeLabel: `${window.opensOn} – ${window.closesOn}`, windowHref: `${closeHref}&window=${encodeURIComponent(window.id)}`, openLabel: hrm('benefits.openWindow'),
    }))
    let windowDrawer: WindowDrawerData | null = null
    if (sp.window && sp.window !== 'new') {
      const window = windowRows.find(row => row.id === sp.window)
      if (!window) notFound()
      const enrollments = (await listEnrollments(db, authz.user.orgId, authz.user.id)).filter(row => row.windowId === window.id)
      const statuses = new Map<string, number>()
      enrollments.forEach(row => statuses.set(row.status, (statuses.get(row.status) ?? 0) + 1))
      windowDrawer = { window, progressLabel: hrm('benefits.drawerProgress'), progress: [...statuses].map(([value, count]) => ({ value, count, label: hrm(`benefits.statusNames.${value}`) })),
        enrolments: enrollments.map(row => ({ ...row, employeeLabel: row.employeeName ?? row.employmentId, employeeHref: null,
          employeeContributionLabel: benefitContributionLabels(row.contributions, row.currency, admin, 'employee'), employerContributionLabel: benefitContributionLabels(row.contributions, row.currency, admin, 'employer'), statusLabel: hrm(`benefits.statusNames.${row.status}`),
          statusVariant: row.status === 'active' ? 'success' : 'outline', configurationHref: `${closeHref}&enrollmentConfig=${encodeURIComponent(row.id)}`,
          openLabel: hrm('benefits.openEnrollment'), windowHref: null,
        })) }
    }
    let enrollmentDialog: BenefitElectDialogStrings | null = null
    let subsidiaryOptions: { value: string; label: string }[] = []
    let departmentOptions: { value: string; label: string }[] = []
    if ((sp.enrollment === 'new' || sp.window === 'new') && !canManage) notFound()
    if (sp.enrollment === 'new' || sp.window === 'new') {
      const subsidiaries = (await db.execute<{ id: string; name: string }>(sql`select id,name from subsidiaries where org_id=${authz.user.orgId} and is_active ${subsidiaryVisibleFilter(sql`id`, authz.allowedSubsidiaryIds)} order by name,id`)).rows
      subsidiaryOptions = subsidiaries.map(row => ({ value: row.id, label: row.name }))
      departmentOptions = (await listScopedDepartmentOptions(authz.user.orgId, authz.allowedSubsidiaryIds)).map(row => ({ value: row.id, label: row.name }))
    }
    let employmentOptions: { value: string; label: string }[] = []
    if (creatingVacation || sp.enrollment === 'new') employmentOptions = (await db.execute<{ value: string; label: string }>(sql`select w.id as value,p.display_name as label from worker_employments w join parties p on p.org_id=w.org_id and p.id=w.worker_party_id
      where w.org_id=${authz.user.orgId} ${subsidiaryVisibleFilter(sql`w.employer_subsidiary_id`, authz.allowedSubsidiaryIds)} order by p.display_name,w.id`)).rows
    if (sp.enrollment === 'new') {
      const plans = await listEnrollmentPlanOptions(db, authz.user.orgId, authz.user.id)
      enrollmentDialog = { title: hrm('benefits.newEnrollment'), description: hrm('me.benefits.electDescription'),
        employmentLabel: t('employee'), employments: employmentOptions, initialPlanId: plans.some(plan => plan.value === sp.benefitProgram) ? sp.benefitProgram : undefined, planLabel: t('program'), plans,
        windowLabel: hrm('me.benefits.columns.window'), windows: windows.filter(window => window.status === 'open').map(window => ({ value: window.id, label: `${window.name} (${window.opensOn} – ${window.closesOn})` })),
        fromLabel: hrm('me.benefits.fromLabel'), lifeEventLabel: hrm('me.benefits.lifeEventLabel'), lifeEventPlaceholder: hrm('me.benefits.lifeEventPlaceholder'),
        submitLabel: hrm('benefits.newEnrollment'), cancelLabel: hrm('benefits.cancel'), submitFailed: hrm('me.benefits.electFailed'),
      }
    }
    return <>
      <ListPageLayout header={<PageHeader title={t('title')} description={t('description')} actions={<>
        <Button asChild variant="outline"><Link href={windowsHref as never}>{hrm('benefits.windowsTitle')}</Link></Button>
        {canManage ? <Button asChild><Link href={`${closeHref}&enrollment=new` as never}>{hrm('benefits.newEnrollment')}</Link></Button> : null}
      </>} />}>
        <PreparedPagedTable source="hrm_employee_benefits" rows={filtered.map(row => ({ id: row.id,
          searchText: `${row.employeeName} ${row.programName} ${row.programTypeLabel} ${row.statusLabel}`,
          cells: [<Link key="employee" href={row.employeeHref as never} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{row.employeeName}</Link>,
            <Link key="program" href={row.programHref as never} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{row.programName}</Link>, row.programTypeLabel,
            `${row.effectiveFrom} – ${row.effectiveTo ?? '…'}`, <Badge key="status" variant={row.status === 'active' ? 'success' : 'outline'}>{row.statusLabel}</Badge>,
            <Link key="open" href={row.assignmentHref as never} className="text-teal-700 hover:underline dark:text-teal-300">{t('openAssignment')}</Link>],
        }))} columns={[{ key: 'employee', header: t('employee') }, { key: 'program', header: t('program') }, { key: 'type', header: t('type') }, { key: 'effective', header: t('effective') }, { key: 'status', header: t('status') }, { key: 'open', header: '' }]}
          toolbarAfter={<ListFilterSelect basePath="/hrm/benefits" currentParams={currentParams} paramKey="benefitProgram" label={t('program')} allLabel={hrm('benefits.allLabel')} options={programs} />}
          empty={<div><p className="text-sm font-medium">{t('emptyTitle')}</p><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('emptyDescription')}</p></div>} />
      </ListPageLayout>
      {loadedEnrollment ? <EnrollmentDrawer record={loadedEnrollment.record} canManage={canManage} canChange={loadedEnrollment.canChange} closeHref={closeHref} /> : null}
      {vacation || creatingVacation ? <SetupDrawer entity={{ ...PAYROLL_VACATION_TERMS_ENTITY, readOnly: !canManage }} row={vacation ?? null} members={[]} closeHref={closeHref}
        refOptions={{ 'worker-employments': vacationAssignment ? [{ value: vacationAssignment.employmentId, label: vacationAssignment.employeeName }] : employmentOptions, 'entitlement-plans': programs }}
        fixedValues={vacationAssignment ? { employmentId: vacationAssignment.employmentId, planId: vacationAssignment.programId } : { planId: sp.benefitProgram }}
        initialValues={creatingVacation && employmentOptions.length === 1 ? { employmentId: employmentOptions[0]!.value } : undefined} mutationBasePath="/api/hrm/benefit-plan-configuration" /> : null}
      {sp.windows === '1' && !sp.window ? <WindowsManagerDrawer rows={windowRows} closeHref={closeHref} newHref={`${closeHref}&window=new`} canManage={canManage} /> : null}
      {enrollmentDialog ? <BenefitElectDialog dialog={enrollmentDialog} closeHref={closeHref} mode="manage" /> : null}
      {sp.window === 'new' ? <WindowDialog closeHref={windowsHref} subsidiaryOptions={subsidiaryOptions} departmentOptions={departmentOptions} /> : null}
      {windowDrawer ? <WindowDrawer drawer={windowDrawer} closeHref={windowsHref} canManage={canManage} /> : null}
    </>
  }, { isolationLevel: 'REPEATABLE READ', readOnly: true }).catch(error => {
    if (!(error instanceof BenefitsError) && !(error instanceof EmployeeBenefitAssignmentError)) throw error
    return <ListPageLayout header={<PageHeader title={t('title')} description={t('description')} />}><Alert variant="destructive">{error.message}</Alert></ListPageLayout>
  })
}
