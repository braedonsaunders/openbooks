import { NextResponse } from 'next/server'
import { isUuid } from '../../../../../../lib/list-params'
import { listFileActivity } from '../../../../../../lib/file-audit'
import { requireFolderAccess, requireSession } from '../../../lib'

export const runtime = 'nodejs'

/** Activity history for a folder. Requires at least Viewer access. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const access = await requireFolderAccess(gate, id, 'viewer')
  if (access) return access
  const entries = await listFileActivity(gate.user.orgId, 'folders', id)
  return NextResponse.json({ entries })
}
