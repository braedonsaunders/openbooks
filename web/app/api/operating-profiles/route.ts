import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { OperatingProfileError, publishOperatingProfile } from '@openbooks/engine/src/organization/operating-profiles.ts'
import { ProfileBody } from './contract'
export const POST = defineRoute({ permission: 'admin.setup.manage', feature: { none: 'Profile definitions check their native work-family feature in the publishing transaction.' }, scope: 'unrestricted', body: ProfileBody,
  handler: async ({ request, authz, body }) => {
    const id = request.headers.get('Idempotency-Key')?.trim()
    if (!id) throw new OperatingProfileError('A new workflow requires an idempotency key.', 400)
    return withOrgTransaction(authz.user.orgId, async () => NextResponse.json(await publishOperatingProfile(db, authz.user.orgId, authz.user.id, { ...body, id, expectedVersion: 0 }), { status: 201 }))
  },
})
