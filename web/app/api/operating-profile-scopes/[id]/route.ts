import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { OperatingProfileError, saveOperatingProfileScope } from '@openbooks/engine/src/organization/operating-profiles.ts'
import { ScopeBody } from '../contract'
export const PATCH = defineRoute({ permission: 'admin.setup.manage', scope: 'unrestricted', feature: { none: 'The command fences the selected native work-family and capture features.' }, params: z.object({ id: z.string().uuid() }).strict(), body: ScopeBody,
  handler: async ({ authz, body, params }) => {
    if (body.expectedRevision === undefined) throw new OperatingProfileError('Reload the workflow scope before saving.', 409)
    return withOrgTransaction(authz.user.orgId, async () => NextResponse.json(await saveOperatingProfileScope(db, authz.user.orgId, authz.user.id, { ...body, id: params.id, expectedRevision: body.expectedRevision! })))
  },
})
