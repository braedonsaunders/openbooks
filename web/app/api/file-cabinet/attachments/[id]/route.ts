import { NextResponse } from 'next/server'
import { detachAttachment, getAttachmentTarget } from '../../../../../lib/file-cabinet'
import { isUuid } from '../../../../../lib/list-params'
import { canMutateFiles, requireSession } from '../../lib'

export const runtime = 'nodejs'

/** Detach a file from a record (does NOT delete the file). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const targetTable = await getAttachmentTarget(gate.user.orgId, id)
  if (!targetTable) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!canMutateFiles(gate, targetTable)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const ok = await detachAttachment(gate.user.orgId, id)
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
