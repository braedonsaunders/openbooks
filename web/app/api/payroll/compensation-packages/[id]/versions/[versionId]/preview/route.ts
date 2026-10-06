import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { previewCompensationPackageVersion } from '@openbooks/engine/payroll/compensation-packages'
import { previewBody, versionParams } from '../../../../contracts'

export const POST = defineRoute({ permission: 'payroll.read', feature: 'compensationPackages', params: versionParams, body: previewBody, invalidBodyStatus: 422, handler: async ({ authz, params, body }) =>
  NextResponse.json(await previewCompensationPackageVersion({ ...body, orgId: authz.user.orgId, actorId: authz.user.id, packageId: params.id, versionId: params.versionId })) })
