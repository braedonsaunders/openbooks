import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { recordTrainingFeedback } from '@openbooks/engine/hrm/training'
import { participantParams, feedbackBody, trainingCreateKey } from '@/app/api/hrm/training/contracts'
export const POST = defineRoute({
  permission: 'hrm.self.request',
  feature: 'hrmCertifications',
  params: participantParams,
  body: feedbackBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body, request }) => {
    const id = trainingCreateKey(request)
    if (id instanceof Response) return id
    return NextResponse.json(
      await recordTrainingFeedback({
        ...params,
        ...body,
        id,
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        audience: 'self',
      }),
      { status: 201 },
    )
  },
})
