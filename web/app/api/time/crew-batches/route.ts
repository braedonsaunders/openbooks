import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { can } from '../../../../lib/authz'
import { createBatch } from '@openbooks/engine/src/hrm/field-time/crew.ts'
import { listCrewBatches } from '@openbooks/engine/src/hrm/field-time/reads.ts'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'

export const runtime = 'nodejs'

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status })
}

function fieldTime(error: unknown) {
  if (error instanceof FieldTimeError) return bad(error.message)
  throw error
}

/** GET → batch list (?status=&projectId=). Time readers and foremen both land here. */
export async function GET(req: Request) {
  const read = await guardFeaturePermission('time.read', 'fieldTimeCrewEntry')
  const gate = read instanceof NextResponse
    ? await guardFeaturePermission('time.crew.enter', 'fieldTimeCrewEntry')
    : read
  if (gate instanceof NextResponse) return gate
  const url = new URL(req.url)
  try {
    const batches = await listCrewBatches(gate.user.orgId, {
      status: url.searchParams.get('status'),
      projectId: url.searchParams.get('projectId'),
    })
    return NextResponse.json({ batches })
  } catch (error) {
    return fieldTime(error)
  }
}

const createSchema = z.object({
  foremanPartyId: z.string().min(1),
  projectId: z.string().min(1),
  workedOn: z.string().min(1),
  notes: z.string().max(2000).nullable().optional(),
})

/** POST → open a batch for a foreman on a project day. */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('time.crew.enter', 'fieldTimeCrewEntry')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = createSchema.safeParse((parsedBody.data) as Record<string, unknown>)
  if (!parsed.success) return bad('A batch needs the foreman, the project and the worked day')
  try {
    const id = await createBatch({
      orgId: user.orgId,
      actorUserId: user.id,
      foremanPartyId: parsed.data.foremanPartyId,
      projectId: parsed.data.projectId,
      workedOn: parsed.data.workedOn,
      notes: parsed.data.notes ?? null,
      canManageAll: can(gate, 'time.manage'),
    })
    return NextResponse.json({ id })
  } catch (error) {
    return fieldTime(error)
  }
}
