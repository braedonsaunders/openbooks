import { NextRequest, NextResponse } from 'next/server'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * Instant-into-draft: create an inactive placeholder item and return its id.
 * The flyout edits it in place; activation requires a real name.
 */
export async function POST(_req: NextRequest) {
  const gate = await guardPermission('items.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const [item] = await db
    .insert(schema.items)
    .values({
      orgId: user.orgId,
      kind: 'service',
      name: 'New item',
      isActive: false,
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: schema.items.id })

  return NextResponse.json(item)
}
