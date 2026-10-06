import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { transitionCompensationPackageVersion } from '@openbooks/engine/payroll/compensation-packages'
import { decisionBody, versionParams } from '../../../../contracts'

export const POST = defineRoute({ permission: 'hrm.compensation.approve', feature: 'compensationPackages', params: versionParams, body: decisionBody, invalidBodyStatus: 422, handler: async ({ authz, params, body }) =>
  NextResponse.json(await transitionCompensationPackageVersion({ ...body, orgId: authz.user.orgId, actorId: authz.user.id, packageId: params.id, versionId: params.versionId })) })
