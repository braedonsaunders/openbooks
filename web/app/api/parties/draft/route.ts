import { NextResponse } from 'next/server'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * Instant-into-draft: create an inactive placeholder party and return its id.
 * The flyout edits it in place; activation requires a real display name.
 */
export async function POST() {
  const gate = await guardPermission('parties.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const [party] = await db
    .insert(schema.parties)
    .values({
      orgId: user.orgId,
      kind: 'company',
      displayName: 'New party',
      isActive: false,
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: schema.parties.id })

  return NextResponse.json(party)
}
