import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { OperatingProfileError, saveOperatingProfileScope } from '@openbooks/engine/src/organization/operating-profiles.ts'
import { ScopeBody } from './contract'
export const POST = defineRoute({ permission: 'admin.setup.manage', scope: 'unrestricted', feature: { none: 'The command fences the selected native work-family and capture features.' }, body: ScopeBody,
  handler: async ({ request, authz, body }) => {
    const id = request.headers.get('Idempotency-Key')?.trim()
    if (!id) throw new OperatingProfileError('A new workflow scope requires an idempotency key.', 400)
    return withOrgTransaction(authz.user.orgId, async () => NextResponse.json(await saveOperatingProfileScope(db, authz.user.orgId, authz.user.id, { ...body, id, expectedRevision: 0 }), { status: 201 }))
  },
})
