import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { createTrainingSession } from '@openbooks/engine/hrm/training'
import { courseParams, sessionBody, trainingCreateKey } from '../../../contracts'
export const POST = defineRoute({
  permission: 'hrm.certifications.manage',
  feature: 'hrmTraining',
  params: courseParams,
  body: sessionBody,
  invalidBodyStatus: 422,
  handler: async ({ request, authz, params, body }) => {
    const id = trainingCreateKey(request)
    if (typeof id !== 'string') return id
    return NextResponse.json(
      await createTrainingSession({ ...params, ...body, id, orgId: authz.user.orgId, actorId: authz.user.id }),
      { status: 201 },
    )
  },
})
