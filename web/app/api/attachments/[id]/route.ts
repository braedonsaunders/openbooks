import { NextResponse } from 'next/server'
import { deleteAttachment, getAttachmentTargetTable } from '../../../../lib/attachments'
import { isUuid } from '../../../../lib/list-params'
import { canMutateAttachments, requireSession } from '../lib'

export const runtime = 'nodejs'

/** Remove an attachment. Same permission gate as upload (per target table). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const targetTable = await getAttachmentTargetTable(gate.user.orgId, id)
  if (!targetTable) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!canMutateAttachments(gate, targetTable)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const removed = await deleteAttachment(gate.user.orgId, id)
  if (!removed) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
