import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { getTrainingSession, transitionTrainingSession } from '@openbooks/engine/hrm/training'
import { sessionParams, sessionAction } from '../../contracts'
export const GET = defineRoute({
  permission: 'hrm.certifications.read',
  feature: 'hrmTraining',
  params: sessionParams,
  handler: async ({ authz, params }) =>
    NextResponse.json(await getTrainingSession({ ...params, orgId: authz.user.orgId, actorId: authz.user.id })),
})
export const POST = defineRoute({
  permission: 'hrm.certifications.manage',
  feature: 'hrmTraining',
  params: sessionParams,
  body: sessionAction,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await transitionTrainingSession({ ...params, ...body, orgId: authz.user.orgId, actorId: authz.user.id }),
    ),
})
