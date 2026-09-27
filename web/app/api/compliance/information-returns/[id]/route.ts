import { defineRoute } from '@/lib/api/route'
import { z } from 'zod'
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json"
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  finalizeFiling,
  InformationReturnError,
  markFilingFiled,
  recomputeFiling,
  voidFiling,
} from '@openbooks/engine/src/compliance/information-returns.ts'
import { can, guardSubsidiaryScope } from '@/lib/authz';
import { guardComplianceFeature, loadInformationReturnFilingScope } from '@/lib/compliance'
import { complianceWriteFailure } from '@/lib/compliance-errors'
import { isUuid } from '@/lib/list-params'
import { notFound } from "@/lib/api/responses";

const requestBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('compute') }),
  z.object({ action: z.literal('finalize') }),
  z.object({
    action: z.literal('file'),
    channel: z.enum(['iris', 'fire', 'paper', 'provider', 'other'], { error: 'channel must name a filing channel' }),
    reference: z.string().trim().max(200).nullable().optional(),
  }),
  z.object({
    action: z.literal('void'),
    reason: z.string().trim().min(1, 'reason is required to void a filing').max(2000),
  }),
], { error: 'action must be compute, finalize, file, or void' })



export const runtime = 'nodejs'

const FILING_CHANNELS = new Set(['iris', 'fire', 'paper', 'provider', 'other'])

/**
 * Drive a filing through compute → finalize → filed.
 *
 * `compute` is bookkeeping and needs `compliance.manage`. `finalize` and `file`
 * commit the organisation to a statutory position and need `compliance.file` —
 * whoever prepares the worksheet is not necessarily authorised to transmit it.
 */
export const POST = defineRoute({
  public: 'session',
  params: z.object({ "id": z.string() }),
  handler: async ({ request: req, params: routeParams, authz }) => {
    const params = Promise.resolve(routeParams);
    const blocked = await guardComplianceFeature(authz.user.orgId)
    if (blocked) return blocked
    const { orgId, id: actorId } = authz.user
    const { id } = await params
    if (!isUuid(id)) return notFound("record")

    const parsedBody = await parseJsonBody(req, requestBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.data
    const action = body.action
    if (!action) return NextResponse.json({ error: 'action is required' }, { status: 400 })
    const needed = action === 'compute' ? 'compliance.manage' : 'compliance.file'
    if (!can(authz, needed)) {
      return NextResponse.json({ error: `missing permission: ${needed}` }, { status: 403 })
    }
    // Entity isolation: the engine is scope-blind, so the filing's subsidiary is
    // checked here before any action — an out-of-scope filing is indistinguishable
    // from a missing one (the same 404 the list and create paths use).
    const filingScope = await loadInformationReturnFilingScope(orgId, id)
    if (!filingScope) return notFound("record")
    const scopeDenied = guardSubsidiaryScope(authz, filingScope.subsidiaryId)
    if (scopeDenied) return scopeDenied

    try {
      if (action === 'compute') {
        const { computation } = await recomputeFiling({ orgId, filingId: id, actorId })
        return NextResponse.json({
          recipients: computation.recipients.length,
          tracedCash: computation.tracedCash,
          exceptions: computation.exceptions,
        })
      }
      if (action === 'finalize') {
        await finalizeFiling({ orgId, filingId: id, actorId })
      } else if (action === 'file') {
        if (!FILING_CHANNELS.has(body.channel ?? '')) {
          return NextResponse.json(
            { error: `channel must be one of ${[...FILING_CHANNELS].join(', ')}` },
            { status: 400 },
          )
        }
        await markFilingFiled({
          orgId,
          filingId: id,
          channel: body.channel as 'iris' | 'fire' | 'paper' | 'provider' | 'other',
          reference: body.reference ?? null,
          actorId,
        })
      } else if (action === 'void') {
        const reason = (body.reason ?? '').trim()
        if (!reason) return NextResponse.json({ error: 'voiding a filing needs a reason' }, { status: 400 })
        // Void through the service, never a bare UPDATE here: the service locks
        // the row and refuses to void a FILED return — transmitted evidence is
        // permanent — and commits the lifecycle write together with its audit
        // evidence in one unit.
        await voidFiling({ orgId, filingId: id, actorId, reason })
        return NextResponse.json({ id })
      } else {
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
      }
      await db.execute(sql`
        insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'information_return_filings', ${id}, ${action},
                ${JSON.stringify({ after: body })}::jsonb, ${actorId})`)
      return NextResponse.json({ id })
    } catch (e) {
      if (e instanceof InformationReturnError) {
        return apiErrorResponse(e)
      }
      return complianceWriteFailure(e)
    }

  },
})
