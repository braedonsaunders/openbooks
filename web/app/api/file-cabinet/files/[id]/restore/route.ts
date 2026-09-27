import { NextResponse } from 'next/server'
import { restoreFile } from '../../../../../../lib/file-cabinet'
import { isUuid } from '../../../../../../lib/list-params'
import { fileViewer, requireFileAccess, requireSession } from '../../../lib'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

/** Restore a trashed file. Needs Manager on the file. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return notFound("record")
  const access = await requireFileAccess(gate, id, 'manager', { includeInactive: true })
  if (access) return access
  const ok = await restoreFile(gate.user.orgId, id, { actorId: gate.user.id, viewer: fileViewer(gate) })
  if (!ok) return notFound("record")
  return NextResponse.json({ ok: true })
}
