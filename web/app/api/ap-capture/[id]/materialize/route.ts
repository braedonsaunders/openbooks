import { NextResponse } from 'next/server'
import { materializeCapture, CaptureMaterializationError } from '@openbooks/engine/src/ap-capture-service.ts'
import { guardPermission } from '../../../../../lib/authz'

export const runtime = 'nodejs'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ap.create')
  if (gate instanceof NextResponse) return gate
  try {
    const { id } = await params
    return NextResponse.json(await materializeCapture({ orgId: gate.user.orgId, captureItemId: id, actorId: gate.user.id }))
  } catch (error) {
    if (error instanceof CaptureMaterializationError) return NextResponse.json({ error: error.message }, { status: 422 })
    throw error
  }
}
