import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { getTrainingCourse, transitionTrainingCourse } from '@openbooks/engine/hrm/training'
import { courseParams, courseAction } from '../../contracts'
export const GET = defineRoute({
  permission: 'hrm.certifications.read',
  feature: 'hrmCertifications',
  params: courseParams,
  handler: async ({ authz, params }) =>
    NextResponse.json(await getTrainingCourse({ ...params, orgId: authz.user.orgId, actorId: authz.user.id })),
})
export const POST = defineRoute({
  permission: 'hrm.certifications.manage',
  feature: 'hrmCertifications',
  params: courseParams,
  body: courseAction,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await transitionTrainingCourse({ ...params, ...body, orgId: authz.user.orgId, actorId: authz.user.id }),
    ),
})
