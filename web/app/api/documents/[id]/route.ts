import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { deleteDocument, DeleteError } from '@openbooks/engine/src/document-delete.ts'
import { checkFlowLock, userRoleKeys } from '@openbooks/engine/src/flows/index.ts'
import { getAuthz, can } from '../../../../lib/authz'
import {
  applyDocumentEdit,
  DocumentEditError,
  loadDocument,
  DOC_KINDS,
  createPermission,
  readPermission,
  type DocumentEditCurrent,
  type DocumentEditInput,
} from '../../../../lib/documents'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params

  // Org-scoped existence + kind lookup BEFORE anything is disclosed.
  const owned = (await db.execute(
    sql`select kind from documents where id = ${id} and org_id = ${authz.user.orgId}`,
  )) as unknown as { rows: { kind: string }[] }
  const row = owned.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
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

  const owned = (await db.execute(
    sql`select kind, status, total, tax_total as "taxTotal", party_id as "partyId",
               document_date as "documentDate", updated_at as "updatedAt"
          from documents where id = ${id} and org_id = ${user.orgId}`,
  )) as unknown as { rows: (DocumentEditCurrent)[] }
  const row = owned.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
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

  const body = (await req.json()) as DocumentEditInput
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
  const owned = (await db.execute(
    sql`select kind from documents where id = ${id} and org_id = ${authz.user.orgId}`,
  )) as unknown as { rows: { kind: string }[] }
  const row = owned.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
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
    const body = (await req.json().catch(() => ({}))) as { reason?: string }
    await deleteDocument(id, authz.user.id, {
      source: 'ui',
      reason: body.reason,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof DeleteError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
