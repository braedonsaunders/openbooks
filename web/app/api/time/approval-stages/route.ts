import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { guardUnrestrictedScope } from '../../../../lib/authz'
import { loadChain, saveChain, type ChainSubject } from '@openbooks/engine/src/hrm/field-time/stages.ts'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'

export const runtime = 'nodejs'

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status })
}

/**
 * The engine still owns chain-specific role-stage semantics; this boundary
 * validates every submitted field before those rules run.
 */
const chainBody = z.object({
  subject: z.enum(['timesheet_week', 'crew_time_batch'], {
    error: 'Subject is timesheet_week or crew_time_batch',
  }),
  stages: z.array(z.object({
    order: z.number().int().positive(),
    approverKind: z.enum(['supervisor', 'project_manager', 'payroll', 'role']),
    roleKey: z.string().nullable().optional(),
  }).strict()).min(1).max(5),
}).strict()

/** GET ?subject=timesheet_week|crew_time_batch → the declared chain (null = single approval stands). */
async function legacyGET(req: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const subject = new URL(req.url).searchParams.get('subject')
  if (subject !== 'timesheet_week' && subject !== 'crew_time_batch') {
    return bad('Subject is timesheet_week or crew_time_batch')
  }
  try {
    const stages = await loadChain(gate.user.orgId, subject as ChainSubject)
    return NextResponse.json({ subject, stages })
  } catch (error) {
    if (error instanceof FieldTimeError) return bad(error.message)
    throw error
  }
}

/**
 * PUT {subject, stages} → declare the chain. Validated, never guessed.
 *
 * The chain is org-wide policy with no subsidiary lineage — it governs
 * every entity's timesheets at once — so declaring it needs unrestricted
 * subsidiary scope (canonical shape 2). The read stays open to every
 * time.manage holder: approvers need the chain to do their job, and it
 * discloses no per-subsidiary material.
 */
async function legacyPUT(req: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const { user } = gate
  const scopeDenied = guardUnrestrictedScope(gate)
  if (scopeDenied) return scopeDenied

  const parsedBody = await parseJsonBody(req, chainBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  try {
    const stages = await saveChain({
      orgId: user.orgId,
      actorUserId: user.id,
      subject: body.subject,
      stages: body.stages,
    })
    return NextResponse.json({ subject: body.subject, stages })
  } catch (error) {
    if (error instanceof FieldTimeError) return bad(error.message)
    throw error
  }
}

export const GET = defineRoute({
  permission: 'time.manage', feature: 'fieldTime',

  handler: ({ request, params, authz }) => legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const PUT = defineRoute({
  permission: 'time.manage', feature: 'fieldTime',

  handler: ({ request, params, authz }) => legacyPUT(request, { params: Promise.resolve(params) }, authz),
});
