import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { getTrainingParticipant, respondTrainingInvitation } from '@openbooks/engine/hrm/training'
import { participantParams, responseBody } from '../../contracts'
export const GET = defineRoute({
  permission: 'hrm.certifications.read',
  feature: 'hrmTraining',
  params: participantParams,
  handler: async ({ authz, params }) =>
    NextResponse.json(
      await getTrainingParticipant({ ...params, orgId: authz.user.orgId, actorId: authz.user.id, audience: 'staff' }),
    ),
})
export const POST = defineRoute({
  permission: 'hrm.certifications.manage',
  feature: 'hrmTraining',
  params: participantParams,
  body: responseBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await respondTrainingInvitation({
        ...params,
        ...body,
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        audience: 'staff',
      }),
    ),
})
