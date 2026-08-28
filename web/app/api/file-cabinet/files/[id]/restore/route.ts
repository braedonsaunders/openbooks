import { NextResponse } from 'next/server'
import { restoreFile } from '../../../../../../lib/file-cabinet'
import { isUuid } from '../../../../../../lib/list-params'
import { requireFileAccess, requireSession } from '../../../lib'

export const runtime = 'nodejs'

/** Restore a trashed file. Needs Manager on the file. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const access = await requireFileAccess(gate, id, 'manager')
  if (access) return access
  const ok = await restoreFile(gate.user.orgId, id, { actorId: gate.user.id })
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
