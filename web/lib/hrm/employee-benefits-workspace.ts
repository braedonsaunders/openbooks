import 'server-only'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/platform/database'
import { listBenefitsProgramCatalog, listBenefitsProgramParticipants, listEnrollments } from '@openbooks/engine/hrm/benefits'
import { can, guardSubsidiaryScope, type Authz } from '@/lib/authz'
import { isFeatureEnabled } from '@/lib/features'
import { loadBenefitEnrollmentRecord } from '@/lib/hrm/benefit-enrollment-record'
import { completeBenefitPopulation, employeeBenefitAssignments, type EmployeeBenefitPolicyRow, type EmployeeBenefitsData } from './employee-benefits-types'

/** Benefits is a lens on native employee assignments, not a second employee roster. */
export async function loadEmployeeBenefitAssignments(authz: Authz, employeePartyId?: string) {
  const [catalog, participants, t] = await Promise.all([
    completeBenefitPopulation(query => listBenefitsProgramCatalog(db, authz.user.orgId, authz.user.id, { ...query, includeInternal: true })),
    completeBenefitPopulation(query => listBenefitsProgramParticipants(db, authz.user.orgId, authz.user.id, { ...query, employeePartyId })),
    getTranslations('hrm'),
  ])
  const assignments = employeeBenefitAssignments(catalog, participants, {
    type: type => t(`programIdentity.types.${type}`),
    status: status => t.has(`benefits.statusNames.${status}`) ? t(`benefits.statusNames.${status}`) : t.has(`portfolio.statuses.${status}`) ? t(`portfolio.statuses.${status}`) : status,
  })
  return { assignments, programs: catalog.map(program => ({ value: program.id, label: program.name })) }
}

/** Employee policy reads are fenced by the legal employers the actor can access. */
export async function loadEmployeeBenefitsData(authz: Authz, employeePartyId: string): Promise<EmployeeBenefitsData | null> {
  const employments = (await db.execute<{ id: string; employer: string; subsidiaryId: string }>(sql`
    select w.id,s.name as employer,w.employer_subsidiary_id as "subsidiaryId" from worker_employments w
    join subsidiaries s on s.org_id=w.org_id and s.id=w.employer_subsidiary_id
    where w.org_id=${authz.user.orgId} and w.worker_party_id=${employeePartyId}`)).rows
  const visible = employments.filter(row => guardSubsidiaryScope(authz, row.subsidiaryId) === null)
  if (!visible.length) return null
  const ids = visible.map(row => row.id)
  const payroll = await isFeatureEnabled(authz.user.orgId, 'payroll')
  const [assignmentData, enrollments, vacation, service] = await Promise.all([
    loadEmployeeBenefitAssignments(authz, employeePartyId),
    Promise.all(ids.map(employmentId => listEnrollments(db, authz.user.orgId, authz.user.id, { employmentId }))).then(pages => pages.flat()),
    payroll ? db.execute<EmployeeBenefitPolicyRow>(sql`select id,plan_id,employment_id,method,percent_floor::text,annual_days_floor::text,effective_from::text,effective_to::text,reason
      from payroll_vacation_terms where org_id=${authz.user.orgId} and employment_id=any(${sql.param(ids)}::uuid[]) order by effective_from desc,id`).then(result => result.rows) : [],
    payroll ? db.execute<EmployeeBenefitPolicyRow>(sql`select id,employment_id,convention,as_of_date::text,credited_days::text,credited_months::text,effective_from::text,effective_to::text,reason
      from payroll_service_credits where org_id=${authz.user.orgId} and employment_id=any(${sql.param(ids)}::uuid[]) order by effective_from desc,id`).then(result => result.rows) : [],
  ])
  const records = await Promise.all(enrollments.map(row => loadBenefitEnrollmentRecord(authz, row)))
  return { employments: visible.map(({ id, employer }) => ({ value: id, label: employer })), ...assignmentData,
    enrollments: records.map(value => ({ id: value.record.id, ...value })), vacation, service,
    canManage: can(authz, 'hrm.benefits.manage'), canReadBanks: payroll && can(authz, 'payroll.read'), payroll }
}
