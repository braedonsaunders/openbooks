import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { transitionCompensationPackageAssignment } from '@openbooks/engine/payroll/compensation-packages'
import { assignmentActionBody, assignmentParams } from '../../../contracts'

export const POST = defineRoute({ permission: 'payroll.manage', feature: 'payroll', params: assignmentParams, body: assignmentActionBody, invalidBodyStatus: 422, handler: async ({ authz, params, body }) =>
  NextResponse.json(await transitionCompensationPackageAssignment({ ...body, orgId: authz.user.orgId, actorId: authz.user.id, packageId: params.id, assignmentId: params.assignmentId })) })
