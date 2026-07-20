import { NextResponse } from 'next/server'
import { requireSession } from '../../../../lib'
import { deleteGrant } from '../../../../grant-handlers'

export const runtime = 'nodejs'

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; grantId: string }> },
) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id, grantId } = await params
  return deleteGrant(gate, 'file', id, grantId)
}
