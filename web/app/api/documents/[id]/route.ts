import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { isDocumentRevisionToken } from "@/lib/api/registry-data";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { deleteDocument, DeleteError } from '@openbooks/engine/src/document-delete.ts'
import { checkFlowLock, userRoleKeys } from '@openbooks/engine/src/flows/index.ts'
import { getAuthz, can, guardSubsidiaryScope, subsidiariesInScope } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'
import {
  applyDocumentEdit,
  DOCUMENT_EDIT_VERSION_REQUIRED,
  DocumentEditError,
  documentRevisionSql,
  loadDocument,
  DOC_KINDS,
  createPermission,
  isDocKindEnabled,
  readPermission,
  type DocumentEditCurrent,
  type DocumentEditInput,
} from '../../../../lib/documents'

export const runtime = 'nodejs'

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params

  // Org-scoped existence + kind lookup BEFORE anything is disclosed.
  const owned = (await db.execute<{ kind: string; subsidiaryId: string | null }>(
    sql`select kind, subsidiary_id as "subsidiaryId" from documents where id = ${id} and org_id = ${authz.user.orgId}`,
  ))
  const row = owned.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Subsidiary scope before anything else about the record is disclosed —
  // an out-of-scope document reads exactly like a nonexistent one.
  const denied = guardSubsidiaryScope(authz, row.subsidiaryId)
  if (denied) return denied
  if (!(await isDocKindEnabled(authz.user.orgId, row.kind))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!DOC_KINDS[row.kind]) {
    return NextResponse.json({ error: `kind "${row.kind}" is not served here` }, { status: 422 })
  }
  // Per-kind read permission (ap.read for bills/banking, ar.read for
  // invoices/credits, gl.read for transfers) — mirrors the old per-module routes.
  const readPerm = row.kind === 'project_charge' ? 'projects.read' : readPermission(row.kind)
  if (!can(authz, readPerm)) {
    return NextResponse.json({ error: `missing permission: ${readPerm}` }, { status: 403 })
  }

  const doc = await loadDocument(id, authz.user.orgId)
  if (!doc) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json(doc)
}

/**
 * Save a posting document. Auth + status/lock guards live here; the header +
 * lines write, GL re-materialization, transaction audit, and on_update flows
 * are the shared `applyDocumentEdit` service (also used by the REST API), so
 * the two write paths can never diverge.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Auth first: nothing about the document (existence, kind, status) is
  // disclosed to unauthenticated or cross-org callers.
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const user = authz.user
  const { id } = await params

  const owned = (await db.execute<(DocumentEditCurrent & { subsidiaryId: string | null })>(
    sql`select kind, status, total, tax_total as "taxTotal", party_id as "partyId",
               document_date as "documentDate",
               ${documentRevisionSql(sql.raw('updated_at'))} as "updatedAt",
               subsidiary_id as "subsidiaryId"
          from documents where id = ${id} and org_id = ${user.orgId}`,
  ))
  const row = owned.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(authz, row.subsidiaryId)
  if (denied) return denied
  if (!(await isDocKindEnabled(user.orgId, row.kind))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const cfg = DOC_KINDS[row.kind]
  if (!cfg) return NextResponse.json({ error: `kind "${row.kind}" is not editable here` }, { status: 422 })
  const editPerm = row.kind === 'project_charge' ? 'projects.manage' : createPermission(row.kind)
  if (!can(authz, editPerm)) {
    return NextResponse.json({ error: `missing permission: ${editPerm}` }, { status: 403 })
  }
  if (row.status !== 'draft') {
    return NextResponse.json(
      { error: `a ${row.status} document cannot be edited — return it to draft or create a controlled correction` },
      { status: 422 },
    )
  }
  // Flow-managed lock (the lock_record action — source platform "Lock Record" with
  // role exemptions). Independent of document status.
  {
    const roles = await userRoleKeys(user.orgId, user.id)
    const lock = await checkFlowLock(row.kind, id, {
      isAdmin: user.isSuperAdmin || roles.has('admin'),
      roles: [...roles],
    })
    if (lock) {
      return NextResponse.json(
        { error: `this document is locked by a workflow${lock.reason ? ` — ${lock.reason}` : ''}` },
        { status: 409 },
      )
    }
  }

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as DocumentEditInput
  // A restricted caller may not re-home a record into a subsidiary they
  // cannot see — even one that exists and is active.
  if (body.subsidiaryId !== undefined && !subsidiariesInScope(authz, [body.subsidiaryId])) {
    return NextResponse.json({ error: 'invalid subsidiary' }, { status: 422 })
  }
  if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
    return NextResponse.json({ error: DOCUMENT_EDIT_VERSION_REQUIRED }, { status: 409 })
  }
  // Stored inventory / assembly / kit lines stay. Turning Inventory off must
  // 404 a write that would persist a new one of those kinds.
  if (Array.isArray(body.lines) && !(await isFeatureEnabled(user.orgId, 'inventory'))) {
    const stored = (await db.execute<{ item_id: string }>(sql`
      select item_id from document_lines
       where org_id = ${user.orgId} and document_id = ${id} and item_id is not null`))
    const storedIds = new Set(stored.rows.map((row) => row.item_id))
    for (const line of body.lines) {
      if (!line.itemId || !isUuid(line.itemId) || storedIds.has(line.itemId)) continue
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${line.itemId} and org_id = ${user.orgId}`))
      if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
    }
  }
  // Stored equipment_charge lines stay. Turning Equipment off must
  // 404 a write that would persist a new one of those kinds.
  if (Array.isArray(body.lines) && !(await isFeatureEnabled(user.orgId, 'equipment'))) {
    const stored = (await db.execute<{ item_id: string }>(sql`
      select item_id from document_lines
       where org_id = ${user.orgId} and document_id = ${id} and item_id is not null`))
    const storedIds = new Set(stored.rows.map((row) => row.item_id))
    for (const line of body.lines) {
      if (!line.itemId || !isUuid(line.itemId) || storedIds.has(line.itemId)) continue
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${line.itemId} and org_id = ${user.orgId}`))
      if (item.rows[0] && item.rows[0].kind === 'equipment_charge') {
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
    }
  }
  try {
    await applyDocumentEdit(id, row, body, { orgId: user.orgId, userId: user.id, source: 'ui' })
  } catch (e) {
    if (e instanceof DocumentEditError) {
      return NextResponse.json(
        { error: e.message, ...(e.fieldErrors ? { fieldErrors: e.fieldErrors } : {}) },
        { status: e.status },
      )
    }
    throw e
  }

  const doc = await loadDocument(id, user.orgId)
  return NextResponse.json(doc)
}

/** Delete a document (guarded: open period, no applied payments, no downstream conversion). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  const owned = (await db.execute<{ kind: string; subsidiaryId: string | null }>(
    sql`select kind, subsidiary_id as "subsidiaryId" from documents where id = ${id} and org_id = ${authz.user.orgId}`,
  ))
  const row = owned.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(authz, row.subsidiaryId)
  if (denied) return denied
  if (!(await isDocKindEnabled(authz.user.orgId, row.kind))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const cfg = DOC_KINDS[row.kind]
  if (!cfg) return NextResponse.json({ error: `kind "${row.kind}" is not editable here` }, { status: 422 })
  const editPerm = row.kind === 'project_charge' ? 'projects.manage' : createPermission(row.kind)
  if (!can(authz, editPerm)) {
    return NextResponse.json({ error: `missing permission: ${editPerm}` }, { status: 403 })
  }
  // Flow-managed lock: a locked record can't be deleted out from under its
  // workflow either (same exemptions as edits).
  {
    const roles = await userRoleKeys(authz.user.orgId, authz.user.id)
    const lock = await checkFlowLock(row.kind, id, {
      isAdmin: authz.user.isSuperAdmin || roles.has('admin'),
      roles: [...roles],
    })
    if (lock) {
      return NextResponse.json(
        { error: `this document is locked by a workflow${lock.reason ? ` — ${lock.reason}` : ''}` },
        { status: 409 },
      )
    }
  }
  try {
    const parsedBody2 = await parseJsonBody(req, jsonObject);
    if (!parsedBody2.ok) return parsedBody2.response;
    const body = (parsedBody2.data) as { reason?: string; expectedUpdatedAt?: string }
    if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
      return NextResponse.json({ error: DOCUMENT_EDIT_VERSION_REQUIRED }, { status: 409 })
    }
    await deleteDocument(id, authz.user.id, authz.user.orgId, {
      source: 'ui',
      reason: body.reason,
      expectedUpdatedAt: body.expectedUpdatedAt,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof DeleteError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
