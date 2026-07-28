import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { guardProjectsFeature } from '../../../../../../lib/projects-gate'
import {
  updateWorkBreakdownTask,
} from '../../../../../../lib/project-work-breakdown'
import {
  parseExpectedTaskVersion,
  parseWorkBreakdownTaskInput,
  ProjectWorkBreakdownError,
} from '../../../../../../lib/project-work-breakdown-validation'

export const runtime = 'nodejs'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const { id, taskId } = await params
  if (!isUuid(id) || !isUuid(taskId)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  try {
    const rawBody = await request.json().catch(() => {
      throw new ProjectWorkBreakdownError('Task details must be valid JSON')
    })
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      throw new ProjectWorkBreakdownError('Task details are required')
    }
    const body = rawBody as Record<string, unknown>
    const { expectedUpdatedAt, ...taskInput } = body
    const task = await updateWorkBreakdownTask({
      orgId: gate.user.orgId,
      projectId: id,
      taskId,
      actorId: gate.user.id,
      expectedUpdatedAt: parseExpectedTaskVersion(expectedUpdatedAt),
      input: parseWorkBreakdownTaskInput(taskInput),
    })
    return NextResponse.json({ task })
  } catch (error) {
    if (error instanceof ProjectWorkBreakdownError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
}
