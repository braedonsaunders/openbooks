import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { guardProjectsFeature } from '../../../../../lib/projects-gate'
import {
  createWorkBreakdownTask,
  loadWorkBreakdownTasks,
} from '../../../../../lib/project-work-breakdown'
import {
  parseWorkBreakdownTaskInput,
  ProjectWorkBreakdownError,
} from '../../../../../lib/project-work-breakdown-validation'

export const runtime = 'nodejs'

function errorResponse(error: unknown) {
  if (error instanceof ProjectWorkBreakdownError) {
    return NextResponse.json(
      { error: error.status === 404 ? 'not found' : error.message },
      { status: error.status },
    )
  }
  throw error
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('projects.read')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  try {
    return NextResponse.json({
      tasks: await loadWorkBreakdownTasks(gate.user.orgId, id, gate.allowedSubsidiaryIds),
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  try {
    const parsedBody = await parseJsonBody(request, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.data
    const task = await createWorkBreakdownTask({
      orgId: gate.user.orgId,
      projectId: id,
      actorId: gate.user.id,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      input: parseWorkBreakdownTaskInput(body),
    })
    return NextResponse.json({ task }, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}
