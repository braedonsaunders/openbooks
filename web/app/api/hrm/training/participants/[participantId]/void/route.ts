import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { voidTrainingOutcome } from '@openbooks/engine/hrm/training'
import { participantParams, voidBody } from '../../../contracts'
export const POST = defineRoute({
  permission: 'hrm.certifications.manage',
  feature: 'hrmCertifications',
  params: participantParams,
  body: voidBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await voidTrainingOutcome({ ...params, ...body, orgId: authz.user.orgId, actorId: authz.user.id }),
    ),
})
