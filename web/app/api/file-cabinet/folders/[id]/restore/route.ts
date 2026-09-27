import { NextResponse } from 'next/server'
import { restoreFolder } from '../../../../../../lib/file-cabinet'
import { isUuid } from '../../../../../../lib/list-params'
import { fileViewer, requireFolderAccess, requireSession } from '../../../lib'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

/** Restore a trashed folder subtree. Needs Manager on the folder. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return notFound("record")
  const access = await requireFolderAccess(gate, id, 'manager')
  if (access) return access
  const ok = await restoreFolder(gate.user.orgId, id, { actorId: gate.user.id, viewer: fileViewer(gate) })
  if (!ok) return notFound("record")
  return NextResponse.json({ ok: true })
}
