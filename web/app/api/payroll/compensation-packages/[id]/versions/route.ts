import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { saveCompensationPackageVersion } from '@openbooks/engine/payroll/compensation-packages'
import { packageCreateKey, packageParams, versionBody } from '../../contracts'

export const POST = defineRoute({ permission: 'payroll.manage', feature: 'compensationPackages', params: packageParams, body: versionBody, invalidBodyStatus: 422, handler: async ({ request, authz, params, body }) => {
  const key = body.versionId ? undefined : packageCreateKey(request)
  if (key !== undefined && typeof key !== 'string') return key
  return NextResponse.json(await saveCompensationPackageVersion({ ...body, orgId: authz.user.orgId, actorId: authz.user.id, packageId: params.id, idempotencyKey: key }))
} })
