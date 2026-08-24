import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import {
  postDocument,
  PostingError,
  runPostDocumentEffects,
} from '@openbooks/engine/src/posting.ts'
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import {
  ControlAccountsIncompleteError,
  loadRequiredControlAccounts,
} from '@openbooks/engine/src/control-accounts.ts'
import { guardPermission, guardSubsidiaryScope } from '../../../../lib/authz'
import { parseJsonBody, uuidId } from '../../../../lib/api/json'

export const runtime = 'nodejs'

const journalActionBody = z.object({
  action: z.literal('post', { error: 'unknown action' }),
  documentId: z.string({ error: 'documentId required' }).refine(
    (v) => uuidId.safeParse(v).success,
    'documentId required',
  ),
})

/**
 * Manual-journal actions. A draft is submitted through the tenant's active
 * Flow configuration: no gate releases it immediately, while any authored
 * single- or multi-leg gate topology leaves it pending until Flow resolves.
 */
export async function POST(req: Request) {
  const parsed = await parseJsonBody(req, journalActionBody)
  if (!parsed.ok) return parsed.response
  const { documentId } = parsed.data

  try {
    switch (parsed.data.action) {
      case 'post': {
        const gate = await guardPermission('gl.post')
        if (gate instanceof NextResponse) return gate
        const outcome = await withOrgTransaction(gate.user.orgId, async () => {
          // Serialize the lifecycle and posting decision at the aggregate root.
          // If posting fails, the draft→approved release rolls back with it.
          const owned = (await db.execute<{ id: string; status: string; subsidiaryId: string | null }>(sql`
            select id, status, subsidiary_id as "subsidiaryId" from documents
             where id = ${documentId} and kind = 'journal' and org_id = ${gate.user.orgId}
             for update
          `))
          if (!owned.rows[0]) return { kind: 'not_found' as const }
          const scopeDenied = guardSubsidiaryScope(gate, owned.rows[0].subsidiaryId)
          if (scopeDenied) return { kind: 'scope_denied' as const, response: scopeDenied }
          const previousStatus = owned.rows[0].status
          if (previousStatus === 'draft') {
            const submission = await submitAndReleaseIfUngated(
              'journal',
              documentId,
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
          const entryId = await postDocument(documentId, {
            control: await loadRequiredControlAccounts(gate.user.orgId),
          }, {
            deferEffects: true,
            audit: { actorId: gate.user.id, source: 'ui' },
          })
          return { kind: 'posted' as const, entryId, previousStatus }
        })

        if (outcome.kind === 'not_found') {
          return NextResponse.json({ error: 'not found' }, { status: 404 })
        }
        if (outcome.kind === 'scope_denied') {
          return outcome.response
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
        await runPostDocumentEffects(documentId, outcome.previousStatus)
        return NextResponse.json({ ok: true, entryId: outcome.entryId })
      }
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  } catch (e) {
    // Posting refusals (kernel rules or unconfigured org control accounts) are
    // request-state failures, not server defects.
    const status =
      e instanceof PostingError || e instanceof ControlAccountsIncompleteError
        ? 422
        : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}
