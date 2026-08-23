import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { createDocumentDraft, DOC_KINDS, createPermission, isDocKindEnabled } from '../../../../lib/documents'

export const runtime = 'nodejs'

/** Instant-into-draft: create an empty draft document of the given kind. */
export async function POST(req: Request) {
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { kind?: string }
  if (!body.kind || !DOC_KINDS[body.kind]) {
    return NextResponse.json({ error: 'unknown document kind' }, { status: 400 })
  }
  const gate = await guardPermission(createPermission(body.kind))
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  if (!(await isDocKindEnabled(user.orgId, body.kind))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const doc = await createDocumentDraft(user.orgId, user.id, body.kind)
  return NextResponse.json(doc)
}
