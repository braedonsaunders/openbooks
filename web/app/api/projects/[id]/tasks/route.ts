import { apiErrorResponse } from '@/lib/api/error-response'
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { isUuid } from '../../../../../lib/list-params'
import {
  createWorkBreakdownTask,
  loadWorkBreakdownTasks,
} from '../../../../../lib/project-work-breakdown'
import {
  parseWorkBreakdownTaskInput,
  ProjectWorkBreakdownError,
} from '../../../../../lib/project-work-breakdown-validation'
import { notFound } from "@/lib/api/responses";


const taskParams = z.object({ id: z.string() })
const taskBody = z.object({ code: z.string().nullable().optional(), name: z.string().trim().min(1), status: z.enum(["open", "complete", "cancelled"]).optional(), estimatedHours: z.string().nullable().optional(), estimatedCost: z.string().nullable().optional() })

async function errorResponse(error: unknown): Promise<NextResponse> {
  if (error instanceof ProjectWorkBreakdownError) {
    // A missing project or task reads as a bare 404: existence stays hidden.
    if (error.status === 404) return notFound("record")
    return apiErrorResponse(error)
  }
  throw error
}

export const GET = defineRoute({
  permission: 'projects.read', feature: 'projects', params: taskParams,
  handler: async ({ authz: gate, params: { id } }) => {
  if (!isUuid(id)) return notFound("record")

  try {
    return NextResponse.json({
      tasks: await loadWorkBreakdownTasks(gate.user.orgId, id, gate.allowedSubsidiaryIds),
    })
  } catch (error) {
    return errorResponse(error)
  }
  },
})

export const POST = defineRoute({
  permission: 'projects.manage', feature: 'projects', params: taskParams, body: taskBody,
  handler: async ({ authz: gate, params: { id }, body }) => {
  if (!isUuid(id)) return notFound("record")

  try {
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
  },
})
