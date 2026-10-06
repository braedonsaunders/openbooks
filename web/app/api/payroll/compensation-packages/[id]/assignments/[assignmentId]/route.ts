import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { saveCompensationPackageAssignment, transitionCompensationPackageAssignment } from '@openbooks/engine/payroll/compensation-packages'
import { assignmentActionBody, assignmentParams, assignmentUpdateBody } from '../../../contracts'

export const POST = defineRoute({ permission: 'payroll.manage', feature: 'compensationPackages', params: assignmentParams, body: assignmentActionBody, invalidBodyStatus: 422, handler: async ({ authz, params, body }) =>
  NextResponse.json(await transitionCompensationPackageAssignment({ ...body, orgId: authz.user.orgId, actorId: authz.user.id, packageId: params.id, assignmentId: params.assignmentId })) })

export const PATCH = defineRoute({ permission: 'payroll.manage', feature: 'compensationPackages', params: assignmentParams, body: assignmentUpdateBody, invalidBodyStatus: 422, handler: async ({ authz, params, body }) =>
  NextResponse.json(await saveCompensationPackageAssignment({ ...body, orgId: authz.user.orgId, actorId: authz.user.id, packageId: params.id, assignmentId: params.assignmentId })) })
