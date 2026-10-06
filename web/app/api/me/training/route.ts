import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { listOwnTraining } from '@openbooks/engine/hrm/training'
export const GET = defineRoute({
  permission: 'hrm.self.read',
  feature: 'hrmTraining',
  handler: async ({ authz }) =>
    NextResponse.json(await listOwnTraining({ orgId: authz.user.orgId, actorId: authz.user.id })),
})
