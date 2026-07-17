import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { submitForApproval } from '@openbooks/engine/src/approvals.ts'
import { postDocument, PostingError } from '@openbooks/engine/src/posting.ts'
import { createObligationsFromInvoice } from '@openbooks/engine/src/revenue-recognition.ts'
import { getAuthz, can } from '../../../../lib/authz'
import { controlDeps, DOC_KINDS, createPermission, postPermission } from '../../../../lib/documents'

export const runtime = 'nodejs'

/**
 * Submit a draft for approval, or post an approved/draft document.
 *
 * For kinds without a seeded approval policy (credit memos today), submit
 * gracefully falls back to marking the document approved so it can be posted —
 * credits still route through the same draft → submit → post flow as bills and
 * invoices, without requiring a per-kind policy seed.
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
      try {
        const requestId = await submitForApproval(doc.kind, doc.id)
        return NextResponse.json({ ok: true, requestId })
      } catch (e) {
        const msg = (e as Error).message
        if (msg.includes('no active approval policy')) {
          // No policy seeded for this kind. Only direct-post kinds and credit
          // memos may skip straight to approved (the credits fallback this
          // route exists for) — bills and invoices must have a policy, or a
          // creator could self-approve them.
          const mayAutoApprove =
            cfg.directPost || doc.kind === 'vendor_credit' || doc.kind === 'customer_credit'
          if (!mayAutoApprove) {
            return NextResponse.json({ error: msg }, { status: 422 })
          }
          await db.update(schema.documents)
            .set({ status: 'approved', updatedBy: user.id })
            .where(eq(schema.documents.id, doc.id))
          return NextResponse.json({ ok: true, requestId: null, autoApproved: true })
        }
        throw e
      }
    }
    // post
    const deps = await controlDeps(user.orgId)
    const entryId = await postDocument(doc.id, deps)
    // A posted invoice with rev-rec items spawns performance obligations +
    // recognition schedules (deferred revenue was booked by the posting rule).
    let revenue: { created: number } | undefined
    if (doc.kind === 'customer_invoice') {
      const r = await createObligationsFromInvoice(doc.id, user.orgId, user.id)
      if (r.created > 0) revenue = { created: r.created }
    }
    return NextResponse.json({ ok: true, entryId, ...(revenue ? { revenue } : {}) })
  } catch (e) {
    const status = e instanceof PostingError ? 422 : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}
