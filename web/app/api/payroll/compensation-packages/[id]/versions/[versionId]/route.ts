import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { saveCompensationPackageVersion } from '@openbooks/engine/payroll/compensation-packages'
import { versionParams, versionUpdateBody } from '../../../contracts'

export const PATCH = defineRoute({ permission: 'payroll.manage', feature: 'compensationPackages', params: versionParams, body: versionUpdateBody, invalidBodyStatus: 422, handler: async ({ authz, params, body }) =>
  NextResponse.json(await saveCompensationPackageVersion({ ...body, orgId: authz.user.orgId, actorId: authz.user.id, packageId: params.id, versionId: params.versionId })) })
