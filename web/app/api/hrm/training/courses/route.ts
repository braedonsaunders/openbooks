import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { createTrainingCourse, listTrainingCourses } from '@openbooks/engine/hrm/training'
import { courseBody, trainingCreateKey } from '../contracts'
export const dynamic = 'force-dynamic'
export const GET = defineRoute({
  permission: 'hrm.certifications.read',
  feature: 'hrmCertifications',
  handler: async ({ authz }) =>
    NextResponse.json(await listTrainingCourses({ orgId: authz.user.orgId, actorId: authz.user.id })),
})
export const POST = defineRoute({
  permission: 'hrm.certifications.manage',
  feature: 'hrmCertifications',
  body: courseBody,
  invalidBodyStatus: 422,
  handler: async ({ request, authz, body }) => {
    const id = trainingCreateKey(request)
    if (typeof id !== 'string') return id
    return NextResponse.json(
      await createTrainingCourse({ ...body, id, orgId: authz.user.orgId, actorId: authz.user.id }),
      { status: 201 },
    )
  },
})
