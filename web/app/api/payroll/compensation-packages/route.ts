import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { createCompensationPackage, listCompensationPackages } from '@openbooks/engine/payroll/compensation-packages'
import { createPackageBody, packageCreateKey } from './contracts'

export const dynamic = 'force-dynamic'
export const GET = defineRoute({ permission: 'payroll.read', feature: 'payroll', handler: async ({ authz }) =>
  NextResponse.json(await listCompensationPackages({ orgId: authz.user.orgId, actorId: authz.user.id })) })
export const POST = defineRoute({ permission: 'payroll.manage', feature: 'payroll', body: createPackageBody, invalidBodyStatus: 422, handler: async ({ request, authz, body }) => {
  const key = packageCreateKey(request)
  if (typeof key !== 'string') return key
  return NextResponse.json(await createCompensationPackage({ ...body, orgId: authz.user.orgId, actorId: authz.user.id, idempotencyKey: key }), { status: 201 })
} })
