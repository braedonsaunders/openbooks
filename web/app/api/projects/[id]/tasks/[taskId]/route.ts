import { apiErrorResponse } from '@/lib/api/error-response'
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { isUuid } from '../../../../../../lib/list-params'
import {
  updateWorkBreakdownTask,
} from '../../../../../../lib/project-work-breakdown'
import {
  parseExpectedTaskVersion,
  parseTaskReason,
  parseWorkBreakdownTaskInput,
  ProjectWorkBreakdownError,
} from '../../../../../../lib/project-work-breakdown-validation'
import { notFound } from "@/lib/api/responses";


const taskParams = z.object({ id: z.string(), taskId: z.string() })
const taskBody = z.object({
  code: z.string().nullable().optional(), name: z.string().trim().min(1), status: z.enum(["open", "complete", "cancelled"]).optional(),
  estimatedHours: z.string().nullable().optional(), estimatedCost: z.string().nullable().optional(),
  expectedUpdatedAt: z.string(), reason: z.string().nullable().optional(),
})

export const PATCH = defineRoute({
  permission: 'projects.manage', feature: 'projects', params: taskParams, body: taskBody,
  handler: async ({ authz: gate, params: { id, taskId }, body }) => {
  if (!isUuid(id) || !isUuid(taskId)) {
    return notFound("record")
  }

  try {
    // reason rides alongside the editor payload, not inside it: the input
    // parser rejects unknown task fields, and the reason evidences closed
    // transitions (reopens, closed-task budget changes) in the audit row.
    const { expectedUpdatedAt, reason: rawReason, ...taskInput } = body
    const task = await updateWorkBreakdownTask({
      orgId: gate.user.orgId,
      projectId: id,
      taskId,
      actorId: gate.user.id,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      expectedUpdatedAt: parseExpectedTaskVersion(expectedUpdatedAt),
      input: parseWorkBreakdownTaskInput(taskInput),
      reason: parseTaskReason(rawReason),
    })
    return NextResponse.json({ task })
  } catch (error) {
    if (error instanceof ProjectWorkBreakdownError) {
      // A missing project or task reads as a bare 404: existence stays hidden.
      if (error.status === 404) return notFound("record")
      return apiErrorResponse(error)
    }
    throw error
  }
  },
})
