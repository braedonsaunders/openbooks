import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { createDocumentDraft, DOC_KINDS, createPermission } from '../../../../lib/documents'

export const runtime = 'nodejs'

/** Instant-into-draft: create an empty draft document of the given kind. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { kind?: string }
  if (!body.kind || !DOC_KINDS[body.kind]) {
    return NextResponse.json({ error: 'unknown document kind' }, { status: 400 })
  }
  const gate = await guardPermission(createPermission(body.kind))
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const doc = await createDocumentDraft(user.orgId, user.id, body.kind)
  return NextResponse.json(doc)
}
