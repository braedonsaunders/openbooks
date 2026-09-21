import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { loadChain, saveChain, type ChainSubject } from '@openbooks/engine/src/hrm/field-time/stages.ts'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'

export const runtime = 'nodejs'

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status })
}

/**
 * The chain body. The subject is closed here because only two subjects
 * have adapters; the stages stay unknown to this boundary because
 * validateStages in the engine is what names a bad stage, an unknown
 * approver kind or a role stage with no role.
 */
const chainBody = z.object({
  subject: z.enum(['timesheet_week', 'crew_time_batch'], {
    error: 'Subject is timesheet_week or crew_time_batch',
  }),
  stages: z.array(z.unknown()),
})

/** GET ?subject=timesheet_week|crew_time_batch → the declared chain (null = single approval stands). */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('time.manage', 'fieldTime')
  if (gate instanceof NextResponse) return gate
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

/** PUT {subject, stages} → declare the chain. Validated, never guessed. */
export async function PUT(req: Request) {
  const gate = await guardFeaturePermission('time.manage', 'fieldTime')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

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
