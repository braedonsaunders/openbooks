import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { createDraftJournal } from '../../../../lib/journals'

export const runtime = 'nodejs'

/** Instant-into-draft: create an empty draft manual journal and return its id. */
export async function POST() {
  const gate = await guardPermission('gl.post')
  if (gate instanceof NextResponse) return gate
  const doc = await createDraftJournal(gate.user.orgId, gate.user.id)
  return NextResponse.json(doc)
}
