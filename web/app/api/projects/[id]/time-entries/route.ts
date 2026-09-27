import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { isUuid } from '../../../../../lib/list-params'
import {
  loadProjectTimeEntryPage,
  ProjectTimeDetailError,
  type ProjectTimeDimension,
} from '../../../../../lib/project-time-detail'
import { notFound } from "@/lib/api/responses";


const DIMENSIONS = new Set<ProjectTimeDimension>(['employee', 'item', 'task'])

export const GET = defineRoute({
  permission: 'projects.read',
  feature: 'projects',
  params: z.object({ id: z.string() }),
  handler: async ({ request, authz, params: { id } }) => {
  if (!isUuid(id)) return notFound("record")

  const url = new URL(request.url)
  const rawDimension = url.searchParams.get('dimension')
  const rawKey = url.searchParams.get('key')
  const rawPage = url.searchParams.get('page') ?? '1'
  const page = Number(rawPage)
  if (!rawDimension || !DIMENSIONS.has(rawDimension as ProjectTimeDimension)) {
    return NextResponse.json({ error: 'dimension must be employee, item, or task' }, { status: 422 })
  }
  if (!rawKey || (rawKey !== 'unassigned' && !isUuid(rawKey))) {
    return NextResponse.json({ error: 'key must be a record id or unassigned' }, { status: 422 })
  }
  if (!/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(page)) {
    return NextResponse.json({ error: 'page must be a positive integer' }, { status: 422 })
  }

  try {
    return NextResponse.json(await loadProjectTimeEntryPage({
      orgId: authz.user.orgId,
      projectId: id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      dimension: rawDimension as ProjectTimeDimension,
      dimensionId: rawKey === 'unassigned' ? null : rawKey,
      page,
    }))
  } catch (error) {
    if (error instanceof ProjectTimeDetailError) {
      return apiErrorResponse(error)
    }
    throw error
  }
  },
})
