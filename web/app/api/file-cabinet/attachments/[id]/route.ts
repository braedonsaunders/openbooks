import { NextResponse } from 'next/server'
import { detachAttachment, getAttachmentLink } from '../../../../../lib/file-cabinet'
import { can } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import {
  attachmentReadPermission,
  attachmentTargetInScope,
  canMutateFiles,
  loadAttachmentTarget,
  requireSession,
} from '../../lib'

export const runtime = 'nodejs'

/**
 * Detach a file from a record (does NOT delete the file).
 *
 * Detaching mutates a record's evidence, so it applies the same target gate
 * the attachment listing applies — the owning record must be inside the
 * caller's subsidiary scope (hidden ⇒ indistinguishable 404) and the caller
 * must hold the record family's permission — on top of the cabinet mutation
 * gate. The service refuses to detach from posted documents, active
 * compliance records and fixed assets (their evidence is retained exactly as
 * purge refuses to destroy it); that refusal surfaces as 409.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const link = await getAttachmentLink(gate.user.orgId, id)
  if (!link) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const target = await loadAttachmentTarget(gate.user.orgId, link.targetTable, link.targetId)
  if (!target || !attachmentTargetInScope(gate, target)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const permission = attachmentReadPermission(link.targetTable, target.kind)
  if (!permission) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!can(gate, permission) || !canMutateFiles(gate, link.targetTable)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const result = await detachAttachment(gate.user.orgId, id, { actorId: gate.user.id })
  if (!result.ok) {
    if (result.reason === 'retained') {
      return NextResponse.json({ error: 'attachments of posted or active records are retained' }, { status: 409 })
    }
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
