import { parseJsonBody } from "@/lib/api/json";
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

/** A batch is opened for one foreman on one project day. */
const NEEDS = 'A batch needs the foreman, the project and the worked day'

const createSchema = z.object({
  foremanPartyId: z.string({ error: NEEDS }).min(1, NEEDS),
  projectId: z.string({ error: NEEDS }).min(1, NEEDS),
  workedOn: z.string({ error: NEEDS }).min(1, NEEDS),
  notes: z.string().max(2000).nullable().optional(),
})

/** POST → open a batch for a foreman on a project day. */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('time.crew.enter', 'fieldTimeCrewEntry')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const parsedBody = await parseJsonBody(req, createSchema, { status: 422 });
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const id = await createBatch({
      orgId: user.orgId,
      actorUserId: user.id,
      foremanPartyId: parsedBody.data.foremanPartyId,
      projectId: parsedBody.data.projectId,
      workedOn: parsedBody.data.workedOn,
      notes: parsedBody.data.notes ?? null,
      canManageAll: can(gate, 'time.manage'),
    })
    return NextResponse.json({ id })
  } catch (error) {
    return fieldTime(error)
  }
}
