import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { getCompensationPackage, updateCompensationPackage } from '@openbooks/engine/payroll/compensation-packages'
import { packageParams, updatePackageBody } from '../contracts'

export const dynamic = 'force-dynamic'
export const GET = defineRoute({ permission: 'payroll.read', feature: 'compensationPackages', params: packageParams, handler: async ({ authz, params }) =>
  NextResponse.json(await getCompensationPackage({ orgId: authz.user.orgId, actorId: authz.user.id, packageId: params.id })) })
export const PATCH = defineRoute({ permission: 'payroll.manage', feature: 'compensationPackages', params: packageParams, body: updatePackageBody, invalidBodyStatus: 422, handler: async ({ authz, params, body }) =>
  NextResponse.json(await updateCompensationPackage({ ...body, orgId: authz.user.orgId, actorId: authz.user.id, packageId: params.id })) })
