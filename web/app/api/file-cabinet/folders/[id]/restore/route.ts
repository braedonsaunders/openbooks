import { NextResponse } from 'next/server'
import { restoreFolder } from '../../../../../../lib/file-cabinet'
import { isUuid } from '../../../../../../lib/list-params'
import { recordFileEvent } from '../../../../../../lib/file-audit'
import { requireFolderAccess, requireSession } from '../../../lib'

export const runtime = 'nodejs'

/** Restore a trashed folder subtree. Needs Manager on the folder. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const access = await requireFolderAccess(gate, id, 'manager')
  if (access) return access
  const ok = await restoreFolder(gate.user.orgId, id)
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 })
  await recordFileEvent({
    orgId: gate.user.orgId,
    actorId: gate.user.id,
    table: 'folders',
    rowId: id,
    action: 'restore',
  })
  return NextResponse.json({ ok: true })
}
