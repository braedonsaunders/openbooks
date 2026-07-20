import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { submitForApproval } from '@openbooks/engine/src/flows/index.ts'
import { postDocument, PostingError } from '@openbooks/engine/src/posting.ts'
import { createObligationsFromInvoice } from '@openbooks/engine/src/revenue-recognition.ts'
import {
  applyInventoryIssuesForInvoice,
  applyInventoryReceiptsForBill,
} from '@openbooks/engine/src/inventory.ts'
import { getAuthz, can } from '../../../../lib/authz'
import { controlDeps, DOC_KINDS, createPermission, postPermission } from '../../../../lib/documents'

export const runtime = 'nodejs'

/**
 * Submit a draft for approval, or post an approved/draft document.
 *
 * Approvals are owned by the Flows engine: submit fires the record's on_submit
 * flows. When a flow gates the document it goes pending_approval; when none
 * does, direct-post kinds and credit memos proceed straight to approved (they
 * share the same draft → submit → post flow), while other kinds require an
 * approval flow to be configured.
 */
export async function POST(req: Request) {
  // Auth first: existence/kind/status of documents is never disclosed to
  // unauthenticated or cross-org callers.
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const user = authz.user

  const body = (await req.json()) as {
    action: 'submit' | 'post'
    documentId?: string
  }
  if (!body.documentId) return NextResponse.json({ error: 'documentId required' }, { status: 400 })

  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.id, body.documentId), eq(schema.documents.orgId, user.orgId)))
  if (!doc) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const cfg = DOC_KINDS[doc.kind]
  if (!cfg) return NextResponse.json({ error: `kind "${doc.kind}" is not actionable here` }, { status: 422 })

  const perm = body.action === 'post' ? postPermission(doc.kind) : createPermission(doc.kind)
  if (!can(authz, perm)) {
    return NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 })
  }

  try {
    if (body.action === 'submit') {
      if (doc.status !== 'draft') {
        return NextResponse.json({ error: `document is ${doc.status}, not draft` }, { status: 422 })
      }
      const { gated, runId } = await submitForApproval(doc.kind, doc.id)
      if (gated) {
        return NextResponse.json({ ok: true, requestId: runId })
      }
      // No flow gated this document. Only direct-post kinds and credit memos
      // may skip straight to approved — bills and invoices must have an
      // approval flow, or a creator could self-approve them.
      const mayAutoApprove =
        cfg.directPost || doc.kind === 'vendor_credit' || doc.kind === 'customer_credit'
      if (!mayAutoApprove) {
        return NextResponse.json(
          { error: `no approval flow is configured for ${doc.kind}` },
          { status: 422 },
        )
      }
      await db.update(schema.documents)
        .set({ status: 'approved', updatedBy: user.id })
        .where(eq(schema.documents.id, doc.id))
      return NextResponse.json({ ok: true, requestId: null, autoApproved: true })
    }
    // post
    const deps = await controlDeps(user.orgId)
    const entryId = await postDocument(doc.id, deps)
    const postingDate = (doc.postingDate ?? doc.documentDate) as string
    let revenue: { created: number } | undefined
    let inventory: { movements: number } | undefined
    if (doc.kind === 'customer_invoice') {
      // Rev-rec items spawn obligations + schedules (deferred revenue was booked
      // by the posting rule); inventory items issue to COGS.
      const r = await createObligationsFromInvoice(doc.id, user.orgId, user.id)
      if (r.created > 0) revenue = { created: r.created }
      if (doc.subsidiaryId) {
        const n = await applyInventoryIssuesForInvoice(user.orgId, user.id, doc.id, postingDate, doc.subsidiaryId)
        if (n > 0) inventory = { movements: n }
      }
    } else if (doc.kind === 'vendor_bill' && doc.subsidiaryId && entryId) {
      // Inventory item lines receive stock (bill DR'd clearing/inventory).
      const n = await applyInventoryReceiptsForBill(user.orgId, user.id, doc.id, entryId, postingDate, doc.subsidiaryId)
      if (n > 0) inventory = { movements: n }
    }
    return NextResponse.json({ ok: true, entryId, ...(revenue ? { revenue } : {}), ...(inventory ? { inventory } : {}) })
  } catch (e) {
    const status = e instanceof PostingError ? 422 : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}
