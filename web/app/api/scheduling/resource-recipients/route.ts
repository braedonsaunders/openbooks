import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { saveResourceRecipient } from '@openbooks/engine/src/schedule-boards/resource-recipients.ts'
import { resourceRecipientBody } from './contract'
export const POST = defineRoute({
  permission: 'admin.setup.manage',
  feature: 'projectScheduling',
  body: resourceRecipientBody,
  handler: async ({ authz, body }) =>
    NextResponse.json(
      await saveResourceRecipient(
        { orgId: authz.user.orgId, actorId: authz.user.id },
        body,
      ),
    ),
})
