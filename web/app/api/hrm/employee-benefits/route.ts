import { NextResponse } from 'next/server'
import { withOrgTransaction } from '@openbooks/engine/platform/database'
import { defineRoute } from '@/lib/api/route'
import { isUuid } from '@/lib/list-params'
import { notFound } from '@/lib/api/responses'
import { loadEmployeeBenefitsData } from '@/lib/hrm/employee-benefits-workspace'

export const runtime = 'nodejs'

/** One employee's program assignments and shared service baseline, scoped to legal employer. */
export const GET = defineRoute({
  permission: 'hrm.benefits.read', feature: 'hrm',
  handler: async ({ request, authz }) => {
    const employee = new URL(request.url).searchParams.get('employee')
    if (!employee || !isUuid(employee)) return NextResponse.json({ error: 'Select a valid employee from the employee directory.' }, { status: 422 })
    return withOrgTransaction(authz.user.orgId, async () => {
      const data = await loadEmployeeBenefitsData(authz, employee)
      return data ? NextResponse.json(data) : notFound('employee employment')
    }, { isolationLevel: 'REPEATABLE READ', readOnly: true })
  },
})
