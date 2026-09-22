import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { createSetupRecord, deleteSetupRecord, preflightSetupWrite, updateSetupRecord } from '../../../../../lib/setup/write'

export const runtime = 'nodejs'

/**
 * Generic CRUD for every configuration entity in the Setup registry. The
 * command layer (column whitelisting, validation, feature fence, per-entity
 * rules, audit) lives in web/lib/setup/write.ts and is shared with the
 * assistant/MCP setup-record tools; this route is the HTTP adapter.
 *
 * Gated by admin.setup.manage. Org-scoped (except the shared `currencies`
 * reference table) and audited to audit_log, mirroring the settings route.
 */
const PERMISSION = 'admin.setup.manage'

export async function POST(req: Request, { params }: { params: Promise<{ entity: string }> }) {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const actor = { ...gate.user, permissions: gate.permissions }
  const entityKey = (await params).entity
  const refused = await preflightSetupWrite(actor, entityKey, 'create')
  if (refused) return NextResponse.json(refused.body, { status: refused.status })
  // Creates are idempotent on the caller's key, which becomes the new row's
  // id: the drawer mints one UUID per mounted create session and reuses it
  // across retries and timeouts. The key is required (400, no write) and only
  // read on POST — PATCH never needs it. It is validated after authentication
  // and the entity preflight, so unknown/disabled entities and
  // declared-module creates keep their 404/405 semantics with or without it.
  const requestId = req.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!requestId) {
    return NextResponse.json({ error: 'Idempotency-Key header is required', code: 'invalid' }, { status: 400 })
  }
  if (!isUuid(requestId)) {
    return NextResponse.json({ error: 'Idempotency-Key must be a UUID', code: 'invalid' }, { status: 400 })
  }
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const result = await createSetupRecord(actor, entityKey, parsedBody.data as Record<string, unknown>, { requestId })
  return NextResponse.json(result.body, { status: result.status })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ entity: string }> }) {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const actor = { ...gate.user, permissions: gate.permissions }
  const entityKey = (await params).entity
  const refused = await preflightSetupWrite(actor, entityKey, 'update')
  if (refused) return NextResponse.json(refused.body, { status: refused.status })
  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const result = await updateSetupRecord(actor, entityKey, parsedBody2.data as Record<string, unknown>)
  return NextResponse.json(result.body, { status: result.status })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ entity: string }> }) {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const actor = { ...gate.user, permissions: gate.permissions }
  const entityKey = (await params).entity
  const refused = await preflightSetupWrite(actor, entityKey, 'delete')
  if (refused) return NextResponse.json(refused.body, { status: refused.status })
  const url = new URL(req.url)
  const id = url.searchParams.get('id') ?? ''
  const result = await deleteSetupRecord(actor, entityKey, id)
  return NextResponse.json(result.body, { status: result.status })
}
