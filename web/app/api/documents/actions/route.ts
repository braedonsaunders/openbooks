import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import { postDocument, PostingError } from '@openbooks/engine/src/posting.ts'
import { getAuthz, can } from '../../../../lib/authz'
import { controlDeps, DOC_KINDS, createPermission, postPermission } from '../../../../lib/documents'

export const runtime = 'nodejs'

/**
 * Submit a draft for approval, or post an approved/draft document.
 *
 * Approvals are owned by the Flows engine: submit fires the record's on_submit
 * flows. When a flow gates the document it goes pending_approval; when none
 * does, the engine records that no tenant approval policy applies and releases
 * the document to approved. Posting remains a separately permissioned action.
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
      const { gated, runId, flowError, autoApproved } =
        await submitAndReleaseIfUngated(doc.kind, doc.id, user.id)
      if (gated) {
        return NextResponse.json({ ok: true, requestId: runId })
      }
      if (flowError) {
        // An approval flow matched but errored — fail closed, never auto-approve.
        return NextResponse.json(
          { error: `approval could not be routed: ${flowError}` },
          { status: 422 },
        )
      }
      return NextResponse.json({ ok: true, requestId: null, autoApproved })
    }
    // post
    if (doc.status === 'draft') {
      const submission = await submitAndReleaseIfUngated(doc.kind, doc.id, user.id)
      if (submission.flowError) {
        return NextResponse.json(
          { error: `approval could not be routed: ${submission.flowError}` },
          { status: 422 },
        )
      }
      if (submission.gated) {
        return NextResponse.json(
          { ok: true, pendingApproval: true, requestId: submission.runId },
          { status: 202 },
        )
      }
    } else if (doc.status !== 'approved') {
      return NextResponse.json(
        { error: `document is ${doc.status}; only an approved document can be posted` },
        { status: 422 },
      )
    }
    const deps = await controlDeps(user.orgId)
    const entryId = await postDocument(doc.id, deps, {
      audit: { actorId: user.id, source: 'ui' },
    })
    return NextResponse.json({ ok: true, entryId })
  } catch (e) {
    const status = e instanceof PostingError ? 422 : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}
