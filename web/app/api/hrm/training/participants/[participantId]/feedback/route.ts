import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { recordTrainingFeedback } from '@openbooks/engine/hrm/training'
import { participantParams, feedbackBody, trainingCreateKey } from '../../../contracts'
export const POST = defineRoute({
  permission: 'hrm.certifications.manage',
  feature: 'hrmTraining',
  params: participantParams,
  body: feedbackBody,
  invalidBodyStatus: 422,
  handler: async ({ request, authz, params, body }) => {
    const id = trainingCreateKey(request)
    if (typeof id !== 'string') return id
    return NextResponse.json(
      await recordTrainingFeedback({
        ...params,
        ...body,
        id,
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        audience: 'staff',
      }),
      { status: 201 },
    )
  },
})
