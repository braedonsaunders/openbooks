import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import {
  postDocument,
  PostingError,
  runPostDocumentEffects,
} from '@openbooks/engine/src/posting.ts'
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

async function controlDeps(orgId: string) {
  const r = (await db.execute(sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`)) as any
  const c = r.rows[0]?.c ?? {}
  return { control: { ar: c.ar, ap: c.ap, bank: c.bank, taxCollected: c.taxCollected, taxPaid: c.taxPaid } }
}

/**
 * Manual-journal actions. A draft is submitted through the tenant's active
 * Flow configuration: no gate releases it immediately, while any authored
 * single- or multi-leg gate topology leaves it pending until Flow resolves.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as { action: string; documentId?: string }

  try {
    switch (body.action) {
      case 'post': {
        const gate = await guardPermission('gl.post')
        if (gate instanceof NextResponse) return gate
        if (!body.documentId) {
          return NextResponse.json({ error: 'documentId required' }, { status: 400 })
        }
        const outcome = await withOrgTransaction(gate.user.orgId, async () => {
          // Serialize the lifecycle and posting decision at the aggregate root.
          // If posting fails, the draft→approved release rolls back with it.
          const owned = (await db.execute(sql`
            select id, status from documents
             where id = ${body.documentId} and kind = 'journal' and org_id = ${gate.user.orgId}
             for update
          `)) as unknown as { rows: { id: string; status: string }[] }
          if (!owned.rows[0]) return { kind: 'not_found' as const }
          const previousStatus = owned.rows[0].status
          if (previousStatus === 'draft') {
            const submission = await submitAndReleaseIfUngated(
              'journal',
              body.documentId!,
              gate.user.id,
            )
            if (submission.flowError) {
              return { kind: 'flow_error' as const, error: submission.flowError }
            }
            if (submission.gated) {
              return { kind: 'pending' as const, requestId: submission.runId }
            }
          } else if (previousStatus !== 'approved') {
            return { kind: 'invalid_status' as const, status: previousStatus }
          }

          // Defer after-post scripts/flows until the database transaction has
          // durably committed. Financial writes remain inside this transaction.
          const entryId = await postDocument(
            body.documentId!,
            await controlDeps(gate.user.orgId),
            {
              deferEffects: true,
              audit: { actorId: gate.user.id, source: 'ui' },
            },
          )
          return { kind: 'posted' as const, entryId, previousStatus }
        })

        if (outcome.kind === 'not_found') {
          return NextResponse.json({ error: 'not found' }, { status: 404 })
        }
        if (outcome.kind === 'flow_error') {
          return NextResponse.json(
            { error: `approval could not be routed: ${outcome.error}` },
            { status: 422 },
          )
        }
        if (outcome.kind === 'pending') {
          return NextResponse.json(
            { ok: true, pendingApproval: true, requestId: outcome.requestId },
            { status: 202 },
          )
        }
        if (outcome.kind === 'invalid_status') {
          return NextResponse.json(
            { error: `journal is ${outcome.status}; only an approved journal can be posted` },
            { status: 422 },
          )
        }
        await runPostDocumentEffects(body.documentId, outcome.previousStatus)
        return NextResponse.json({ ok: true, entryId: outcome.entryId })
      }
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  } catch (e) {
    const status = e instanceof PostingError ? 422 : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}
