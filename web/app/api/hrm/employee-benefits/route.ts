import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import { listEnrollments } from '@openbooks/engine/hrm/benefits'
import { defineRoute } from '@/lib/api/route'
import { can, guardSubsidiaryScope } from '@/lib/authz'
import { isUuid } from '@/lib/list-params'
import { notFound } from '@/lib/api/responses'
import { isFeatureEnabled } from '@/lib/features'
import { loadBenefitEnrollmentRecord } from '@/lib/hrm/benefit-enrollment-record'

export const runtime = 'nodejs'

/** One employee's effective benefit policies, fenced by the employment's legal employer. */
export const GET = defineRoute({
  permission: 'hrm.benefits.read', feature: 'hrm',
  handler: async ({ request, authz }) => {
    const employee = new URL(request.url).searchParams.get('employee')
    if (!employee || !isUuid(employee)) return NextResponse.json({ error: 'invalid employee' }, { status: 422 })
    return withOrgTransaction(authz.user.orgId, async () => {
      const employments = (await db.execute<{ id: string; employer: string; subsidiaryId: string }>(sql`
        select w.id,s.name as employer,w.employer_subsidiary_id as "subsidiaryId" from worker_employments w
        join subsidiaries s on s.org_id=w.org_id and s.id=w.employer_subsidiary_id
        where w.org_id=${authz.user.orgId} and w.worker_party_id=${employee} for share of w`)).rows
      const visible = employments.filter(row => guardSubsidiaryScope(authz, row.subsidiaryId) === null)
      if (!visible.length) return notFound('employee employment')
      const ids = visible.map(row => row.id)
      const payroll = await isFeatureEnabled(authz.user.orgId, 'payroll')
      const enrollments = (await Promise.all(ids.map(employmentId => listEnrollments(db, authz.user.orgId, authz.user.id, { employmentId })))).flat()
      const records = await Promise.all(enrollments.map(row => loadBenefitEnrollmentRecord(authz, row)))
      const vacation = payroll ? (await db.execute(sql`select id,employment_id,method,percent_floor::text,annual_days_floor::text,effective_from::text,effective_to::text,reason
        from payroll_vacation_terms where org_id=${authz.user.orgId} and employment_id=any(${sql.param(ids)}::uuid[]) order by effective_from desc,id`)).rows : []
      const service = payroll ? (await db.execute(sql`select id,employment_id,convention,as_of_date::text,credited_days::text,credited_months::text,effective_from::text,effective_to::text,reason
        from payroll_service_credits where org_id=${authz.user.orgId} and employment_id=any(${sql.param(ids)}::uuid[]) order by effective_from desc,id`)).rows : []
      return NextResponse.json({ employments: visible.map(({ id, employer }) => ({ value: id, label: employer })), enrollments: records.map(value => ({ id: value.record.id, ...value })),
        vacation, service, canManage: can(authz, 'hrm.benefits.manage'), canReadBanks: payroll && can(authz, 'payroll.read'), payroll })
    })
  },
})
