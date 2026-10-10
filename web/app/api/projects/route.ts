import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { uuidId, nullableExactMoney } from '@/lib/api/json'
import { unprocessable } from '@/lib/api/responses'
import { isUuid } from '../../../lib/list-params'
import { loadProject } from './_lib'
import { notFound } from "@/lib/api/responses";
import {
  createProject,
  PROJECT_STATUSES,
  ProjectCreateError,
} from '@openbooks/engine/src/projects/project-create.ts'


const projectCreateBody = z.object({
  name: z.string(),
  tasks: z.array(z.object({ name: z.string(), code: z.string().nullable().optional() })).optional(),
  isActive: z.boolean().optional(),
  isInternal: z.boolean().optional(),
  subsidiaryIncludeChildren: z.boolean().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  customerId: uuidId.nullable().optional(),
  foremanId: uuidId.nullable().optional(),
  managerId: uuidId.nullable().optional(),
  subsidiaryId: uuidId.nullable().optional(),
  startsOn: z.string().nullable().optional(),
  endsOn: z.string().nullable().optional(),
  invoicingPreference: z.object({
    defaultBasis: z.enum(["date_range", "draw_amount", "time_selection", "milestone"]).nullable().optional(),
    backupRequired: z.boolean().nullable().optional(),
    backupType: z.enum(["costed_timesheets", "timesheets_purchases", "purchases", "purchases_shop_time", "quote_only", "none"]).nullable().optional(),
  }).nullable().optional(),
  custom: z.record(z.string(), z.json()).optional(),
  contractValue: nullableExactMoney().optional(),
  siteJurisdiction: z.string().nullable().optional(),
  projectTypeId: uuidId.nullable().optional(),
  code: z.string().nullable().optional(),
  customerPoNumber: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  operatingProfile: z.string().nullable().optional(),
  operatingDepartmentId: uuidId.nullable().optional(),
}).strict()

function bad(error: string, field?: string, status = 422) {
  if (status !== 400 && status !== 422) return NextResponse.json({ error, ...(field ? { field } : {}) }, { status })
  return unprocessable(error, { ...(field ? { field } : {}), status: status as 400 | 422 })
}

/**
 * Create one tenant-owned project.
 *
 * The caller supplies a UUID idempotency key, which becomes the project ID.
 * Retrying the same request therefore returns the same project without a
 * duplicate insert or duplicate audit event. A reused key with a changed
 * payload is a 409, never the older project returned as though it matched.
 *
 * This is the only write path for new projects: the list opens an unsaved
 * drawer (zero writes) and this endpoint persists it exactly once through the
 * engine's createProject command, which validates every reference, takes the
 * feature-gate fence, re-checks the `projects` gate and the caller's
 * legal-entity scope in the same transaction, and audits the create.
 */
export const POST = defineRoute({
  permission: 'projects.manage',
  feature: 'projects',
  body: projectCreateBody,
  handler: async ({ request, authz: gate, body }) => {
  const user = gate.user

  const requestId = request.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) return bad('invalid_idempotency_key', undefined, 400)

  if (body.tasks !== undefined) {
    return bad('Work breakdown tasks must be changed through the project task endpoint', 'tasks')
  }

  let created: boolean
  try {
    const result = await createProject(
      { orgId: user.orgId, actorId: user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
      requestId,
      body,
    )
    created = result.created
  } catch (error) {
    if (!(error instanceof ProjectCreateError)) throw error
    if (error.status === 404) return error.code === 'feature_disabled' ? notFound('project') : notFound('record')
    // The idempotency conflict keeps its typed code and remedy for the factory.
    if (error.status === 409) throw error
    return bad(error.message, error.field, error.status)
  }

  const payload = await loadProject(requestId, user.orgId, gate.allowedSubsidiaryIds)
  if (!payload) return bad('save_failed', undefined, 500)
  return NextResponse.json(payload, { status: created ? 201 : 200 })
  },
})
