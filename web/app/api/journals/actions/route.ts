import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { postDocument, PostingError } from '@openbooks/engine/src/posting.ts'
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
        const owned = (await db.execute(sql`
          select id, status from documents
           where id = ${body.documentId} and kind = 'journal' and org_id = ${gate.user.orgId}
        `)) as unknown as { rows: { id: string; status: string }[] }
        if (!owned.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
        if (owned.rows[0].status === 'draft') {
          const submission = await submitAndReleaseIfUngated(
            'journal',
            body.documentId,
            gate.user.id,
          )
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
        } else if (owned.rows[0].status !== 'approved') {
          return NextResponse.json(
            { error: `journal is ${owned.rows[0].status}; only an approved journal can be posted` },
            { status: 422 },
          )
        }

        // postDocument enforces balance (kernel + rule check) and throws on failure
        const entryId = await postDocument(
          body.documentId,
          await controlDeps(gate.user.orgId),
          { audit: { actorId: gate.user.id, source: 'ui' } },
        )
        return NextResponse.json({ ok: true, entryId })
      }
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  } catch (e) {
    const status = e instanceof PostingError ? 422 : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}
