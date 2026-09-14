import { NextResponse } from 'next/server'
import { guardPermission } from '@/lib/authz'
import { applicationContextFromSession } from '@/lib/application/context'
import { activateExtensionDraft, discardExtensionDraft, draftExtension, getExtensionDraft } from '@/lib/application/extensions'
import { ApplicationError } from '@/lib/application/errors'
import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'
export async function POST(request: Request) {
  const gate = await guardPermission('apps.manage')
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(request, jsonObject)
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  const context = applicationContextFromSession(gate, 'api', crypto.randomUUID())
  try {
    if (body.action === 'draft' && typeof body.reason === 'string') return NextResponse.json(await draftExtension(context, { bundle: body.bundle, reason: body.reason }))
    if (body.action === 'discard' && typeof body.draftId === 'string' && isUuid(body.draftId) && typeof body.contentHash === 'string') return NextResponse.json(await discardExtensionDraft(context, { draftId: body.draftId, contentHash: body.contentHash }))
    if (body.action === 'activate' && typeof body.draftId === 'string' && isUuid(body.draftId) && typeof body.contentHash === 'string') return NextResponse.json(await activateExtensionDraft(context, { draftId: body.draftId, contentHash: body.contentHash }))
    return NextResponse.json({ error: 'Invalid draft action' }, { status: 400 })
  } catch (error) {
    if (error instanceof ApplicationError) return NextResponse.json({ error: error.message }, { status: error.status })
    throw error
  }
}
export async function GET(request: Request) {
  const gate = await guardPermission('apps.manage')
  if (gate instanceof NextResponse) return gate
  const id = new URL(request.url).searchParams.get('id')
  if (!id || !isUuid(id)) return NextResponse.json({ error: 'draft id required' }, { status: 400 })
  try { return NextResponse.json(await getExtensionDraft(applicationContextFromSession(gate, 'api', crypto.randomUUID()), id)) }
  catch (error) { if (error instanceof ApplicationError) return NextResponse.json({ error: error.message }, { status: error.status }); throw error }
}
