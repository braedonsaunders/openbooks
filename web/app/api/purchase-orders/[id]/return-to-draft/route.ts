import { z } from 'zod'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { returnDocumentToDraft, ReturnToDraftError } from '@openbooks/engine/src/flows/index.ts'
import { ScopeNotFoundError } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { guardSubsidiaryScope } from '../../../../../lib/authz'

export const runtime = 'nodejs'

const params = z.object({ id: z.string().uuid() })

const returnBody = z.object({
  reason: z.string().trim().min(5, 'a return reason between 5 and 500 characters is required').max(500),
  expectedUpdatedAt: z.string().min(1).optional(),
}).strict()

/**
 * POST return-to-draft: an approved, never-received/never-billed purchase
 * order corrects through edit and re-approval instead of a void on an order
 * that never moved stock. Runs the native document-lifecycle
 * returnDocumentToDraft service (same status, scope, revision and audit
 * contract as the document drawer) — the service itself refuses received or
 * billed lines by name, so a partially applied order meets the amendment
 * path instead.
 */
export const POST = defineRoute({
  permission: 'purchase_orders.create',
  feature: 'orders',
  params,
  body: returnBody,
  handler: async ({ authz, params: { id }, body }) => {
    try {
      const outcome = await withOrgTransaction(authz.user.orgId, async () => {
        const locked = (await db.execute<{ status: string; subsidiaryId: string | null }>(sql`
          select status, subsidiary_id as "subsidiaryId" from documents
           where id = ${id} and kind = 'purchase_order' and org_id = ${authz.user.orgId}
           for update
        `))
        if (!locked.rows[0]) return { kind: 'not_found' as const }
        if (guardSubsidiaryScope(authz, locked.rows[0]?.subsidiaryId)) {
          return { kind: 'scope_revoked' as const }
        }
        const result = await returnDocumentToDraft({
          documentId: id,
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          reason: body.reason,
          expectedUpdatedAt: body.expectedUpdatedAt,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        })
        return { kind: 'returned' as const, result }
      })
      if (outcome.kind === 'not_found' || outcome.kind === 'scope_revoked') {
        return notFound('record')
      }
      return NextResponse.json({ ok: true, supersededRunIds: outcome.result.supersededRunIds })
    } catch (e) {
      if (e instanceof ScopeNotFoundError) return notFound('record')
      if (e instanceof ReturnToDraftError) {
        return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
      }
      throw e
    }
  },
})
