import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { inviteTrainingParticipant } from '@openbooks/engine/hrm/training'
import { sessionParams, invitationBody, trainingCreateKey } from '../../../contracts'
export const POST = defineRoute({
  permission: 'hrm.certifications.manage',
  feature: 'hrmTraining',
  params: sessionParams,
  body: invitationBody,
  invalidBodyStatus: 422,
  handler: async ({ request, authz, params, body }) => {
    const id = trainingCreateKey(request)
    if (typeof id !== 'string') return id
    return NextResponse.json(
      await inviteTrainingParticipant({ ...params, ...body, id, orgId: authz.user.orgId, actorId: authz.user.id }),
      { status: 201 },
    )
  },
})
