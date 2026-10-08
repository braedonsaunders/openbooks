import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { saveResourceRecipient } from '@openbooks/engine/src/schedule-boards/resource-recipients.ts'
import { resourceRecipientBody } from '../contract'
export const PATCH = defineRoute({
  permission: 'admin.setup.manage',
  feature: 'projectScheduling',
  params: z.object({ id: z.string().uuid() }),
  body: resourceRecipientBody.extend({
    expectedRevision: z.number().int().positive(),
  }),
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await saveResourceRecipient(
        { orgId: authz.user.orgId, actorId: authz.user.id },
        { id: params.id, ...body },
      ),
    ),
})
