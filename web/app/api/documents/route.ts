import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { runRecordFlows } from '@openbooks/engine/src/flows/index.ts'
import { can, getAuthz, subsidiariesInScope } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
import { isFeatureEnabled } from '../../../lib/features'
import { DocumentCreateConflict, createDocument, isDocKindEnabled } from "../../../lib/documents.ts";
import { DocumentEditError } from "../../../../engine/src/records/document-edit-policy.ts";
import { loadDocument } from "../../../../engine/src/ledger/document-service.ts";
import { createPermission, isDocumentCreateKind } from "../../../lib/document-kinds.ts";
import type { DocumentEditInput } from "../../../../engine/src/ledger/document-input.ts";

export const runtime = 'nodejs'

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])

/**
 * Explicit create for the shared DOCUMENT transaction kinds (customer
 * invoice/credit, vendor bill/credit, card charge/refund, check, deposit,
 * transfer).
 *
 * The unsaved-create contract (exemplar: POST /api/accounts): clicking New
 * is URL-only (`?doc=new&kind=`) and opens the tenant-customizable
 * DocumentDrawer in createMode over an in-memory payload — no document, no
 * number, no lines, no audit row exist before this endpoint runs on explicit
 * Save. Cancel/close navigates away and writes nothing.
 *
 * The caller supplies a UUID idempotency key, which becomes the document
 * id: retrying the same request returns the same document without a
 * duplicate insert or audit event, while reusing the key for a changed
 * request — or against another org's row — is a 409 conflict. The number
 * allocates here on Save, never on New.
 *
 * Atomicity: the claim, the number, the insert audit, and the full
 * validated header/lines write commit in ONE transaction inside the shared
 * createDocument service (validation is the applyDocumentEdit core PATCH
 * uses, so create refuses exactly what an edit refuses with the same
 * messages). An invalid Save leaves zero document, zero audit insert, zero
 * flow side effects, and no idempotency claim. Creation always yields
 * status=draft; submit/post stay on the existing actions route, so the
 * draft lifecycle after save is unchanged.
 */
export async function POST(req: Request) {
  // Auth first: nothing about tenant state is disclosed to unauthenticated
  // callers. Per-kind permission needs the kind, so this gate only proves
  // identity; the capability check follows once the kind is known.
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const user = authz.user

  const requestId = req.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) {
    return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 400 })
  }

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const { kind: rawKind, ...rest } = parsedBody.data as { kind?: unknown } & Record<string, unknown>
  if (typeof rawKind !== 'string' || !isDocumentCreateKind(rawKind)) {
    return NextResponse.json({ error: 'unknown document kind' }, { status: 400 })
  }
  const kind = rawKind
  // expectedUpdatedAt is a concurrency token minted by a persisted revision;
  // no revision exists before creation. It is transport evidence, not a
  // document field — the fresh row's own token is read inside the service.
  const { expectedUpdatedAt: _dropped, ...editFields } = rest as DocumentEditInput & { expectedUpdatedAt?: unknown }
  void _dropped
  const body = editFields as DocumentEditInput

  const editPerm = createPermission(kind)
  if (!can(authz, editPerm)) {
    return NextResponse.json({ error: `missing permission: ${editPerm}` }, { status: 403 })
  }
  if (!(await isDocKindEnabled(user.orgId, kind))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  // A restricted caller may not home a record into a subsidiary they cannot
  // see — even one that exists and is active. Mirrors PATCH.
  if (body.subsidiaryId !== undefined && !subsidiariesInScope(authz, [body.subsidiaryId])) {
    return NextResponse.json({ error: 'invalid subsidiary' }, { status: 422 })
  }
  // Stored inventory / assembly / kit lines stay. Turning Inventory off must
  // 404 a write that would persist a new one of those kinds. Creation has no
  // stored lines, so every item line is new. Mirrors PATCH minus the
  // stored-ids exemption.
  if (Array.isArray(body.lines) && !(await isFeatureEnabled(user.orgId, 'inventory'))) {
    for (const line of body.lines) {
      if (!line.itemId || !isUuid(line.itemId)) continue
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${line.itemId} and org_id = ${user.orgId}`))
      if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
    }
  }
  // Stored equipment_charge lines stay. Turning Equipment off must 404 a
  // write that would persist a new one. Mirrors PATCH.
  if (Array.isArray(body.lines) && !(await isFeatureEnabled(user.orgId, 'equipment'))) {
    for (const line of body.lines) {
      if (!line.itemId || !isUuid(line.itemId)) continue
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${line.itemId} and org_id = ${user.orgId}`))
      if (item.rows[0] && item.rows[0].kind === 'equipment_charge') {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
    }
  }

  // Default subsidiary: the org root for unrestricted callers, the first
  // in-scope subsidiary for restricted ones. An explicit value (checked
  // against scope above) always wins; an explicit null stays null so the
  // writer refuses it by name instead of silently substituting.
  let subsidiaryId: string | null = null
  if (body.subsidiaryId !== undefined) {
    subsidiaryId = body.subsidiaryId
  } else {
    const roots = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries
       where org_id = ${user.orgId} and is_active and not is_elimination
       order by (parent_id is null) desc, name`)).rows.map((r) => r.id)
    subsidiaryId = roots.find((id) => !authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(id)) ?? null
    if (!subsidiaryId) {
      return NextResponse.json({ error: 'no_available_subsidiary' }, { status: 409 })
    }
  }

  let created: Awaited<ReturnType<typeof createDocument>>
  try {
    created = await createDocument({
      orgId: user.orgId,
      userId: user.id,
      kind,
      key: requestId,
      body,
      subsidiaryId,
      requestBody: parsedBody.data,
    })
  } catch (e) {
    if (e instanceof DocumentCreateConflict) {
      // Fail closed: a reused key with a changed payload, or a key
      // colliding with another org's row, never returns the older row as
      // though it matched.
      return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 409 })
    }
    if (e instanceof DocumentEditError) {
      return NextResponse.json(
        { error: e.message, ...(e.fieldErrors ? { fieldErrors: e.fieldErrors } : {}) },
        { status: e.status },
      )
    }
    throw e
  }

  // Exact retry: the document already exists with this exact request image.
  // Return its current state (it may have advanced past draft since) —
  // no duplicate insert, no duplicate audit event, no flows refired.
  if (created.status === 'replayed') {
    const doc = await loadDocument(created.id, user.orgId)
    if (!doc) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json(doc)
  }

  // Legacy parity for tenant-authored flows: the instant-draft factory fired
  // on_create on the EMPTY draft before the operator typed anything, so flow
  // defaults lose to user input. This create fires on_create first and the
  // deferred on_update second — after the transaction commits, when the row
  // is visible to the flow adapters' own connections. runRecordFlows never
  // throws into the caller.
  await runRecordFlows({ kind: 'on_create', source: 'ui' }, kind, created.id, { orgId: user.orgId, userId: user.id })
  if (created.deferredUpdate) {
    await runRecordFlows(created.deferredUpdate, kind, created.id, { orgId: user.orgId, userId: user.id })
  }

  const doc = await loadDocument(created.id, user.orgId)
  if (!doc) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(doc, { status: 201 })
}
