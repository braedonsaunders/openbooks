import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { saveCompensationPackageAssignment } from '@openbooks/engine/payroll/compensation-packages'
import { assignmentBody, packageCreateKey, packageParams } from '../../contracts'

export const POST = defineRoute({ permission: 'payroll.manage', feature: 'payroll', params: packageParams, body: assignmentBody, invalidBodyStatus: 422, handler: async ({ request, authz, params, body }) => {
  const key = body.assignmentId ? undefined : packageCreateKey(request)
  if (key !== undefined && typeof key !== 'string') return key
  return NextResponse.json(await saveCompensationPackageAssignment({ ...body, orgId: authz.user.orgId, actorId: authz.user.id, packageId: params.id, idempotencyKey: key }))
} })
