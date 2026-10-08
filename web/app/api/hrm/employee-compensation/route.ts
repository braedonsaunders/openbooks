import { NextResponse } from 'next/server'
import { withOrgTransaction } from '@openbooks/engine/platform/database'
import { employeeTotalCompensation } from '@openbooks/engine/hrm/compensation'
import { defineRoute } from '@/lib/api/route'
import { isUuid } from '@/lib/list-params'
import { compensationErrorResponse } from '../compensation/_lib'

export const runtime = 'nodejs'

/**
 * One employee's total compensation: base pay restated in every basis,
 * rate history, projected recurring benefits and allowances, and actual
 * statutory costs and variable pay from committed payroll.
 */
export const GET = defineRoute({
  permission: 'hrm.compensation.read', feature: 'hrm',
  handler: async ({ request, authz }) => {
    const params = new URL(request.url).searchParams
    const employee = params.get('employee')
    const employment = params.get('employment')
    if (!employee || !isUuid(employee)) return NextResponse.json({ error: 'Select a valid employee from the employee directory.' }, { status: 422 })
    if (employment !== null && !isUuid(employment)) return NextResponse.json({ error: 'Select a valid employment for this employee.' }, { status: 422 })
    try {
      const data = await withOrgTransaction(authz.user.orgId, () => employeeTotalCompensation({
        orgId: authz.user.orgId, actorId: authz.user.id, employeePartyId: employee, employmentId: employment,
      }), { isolationLevel: 'REPEATABLE READ', readOnly: true })
      return NextResponse.json(data)
    } catch (error) {
      return compensationErrorResponse(error)
    }
  },
})
