import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { guardProjectsFeature } from '../../../../../lib/projects-gate'
import {
  loadProjectTimeEntryPage,
  ProjectTimeDetailError,
  type ProjectTimeDimension,
} from '../../../../../lib/project-time-detail'

export const runtime = 'nodejs'

const DIMENSIONS = new Set<ProjectTimeDimension>(['employee', 'item', 'task'])

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('projects.read')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature

  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

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
      orgId: gate.user.orgId,
      projectId: id,
      dimension: rawDimension as ProjectTimeDimension,
      dimensionId: rawKey === 'unassigned' ? null : rawKey,
      page,
    }))
  } catch (error) {
    if (error instanceof ProjectTimeDetailError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
}
