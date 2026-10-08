import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { projectEarnedValue } from '@openbooks/engine/src/projects/earned-value.ts'
import { isUuid } from '../../../../../lib/list-params'
import { progressErrorResponse } from '../../../../../lib/project-progress-api'

/** Earned value for one project and its tasks as of a date (default: the business day). */
export const GET = defineRoute({
  permission: 'projects.read',
  feature: 'projectProgress',
  params: z.object({ id: z.string() }),
  handler: async ({ request, authz, params: { id } }) => {
    if (!isUuid(id)) return notFound('record')
    const requested = new URL(request.url).searchParams.get('asOf')
    if (requested !== null && !/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
      return NextResponse.json({ error: 'asOf must be a date (YYYY-MM-DD)' }, { status: 422 })
    }
    try {
      const asOf = requested ?? await businessToday(authz.user.orgId)
      const earned = await projectEarnedValue(authz.user.orgId, id, asOf, authz.allowedSubsidiaryIds ?? null)
      if (!earned) return notFound('record')
      return NextResponse.json(earned)
    } catch (error) {
      return progressErrorResponse(error)
    }
  },
})
