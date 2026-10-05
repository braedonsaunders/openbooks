import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { getTrainingParticipant, respondTrainingInvitation } from '@openbooks/engine/hrm/training'
import { participantParams, selfResponseBody } from '@/app/api/hrm/training/contracts'
export const GET = defineRoute({
  permission: 'hrm.self.read',
  feature: 'hrmCertifications',
  params: participantParams,
  handler: async ({ authz, params }) =>
    NextResponse.json(
      await getTrainingParticipant({ ...params, orgId: authz.user.orgId, actorId: authz.user.id, audience: 'self' }),
    ),
})
export const POST = defineRoute({
  permission: 'hrm.self.request',
  feature: 'hrmCertifications',
  params: participantParams,
  body: selfResponseBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await respondTrainingInvitation({
        ...params,
        ...body,
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        audience: 'self',
      }),
    ),
})
