import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  finalizeFiling,
  InformationReturnError,
  markFilingFiled,
  recomputeFiling,
} from '@openbooks/engine/src/information-returns.ts'
import { getAuthz, can } from '@/lib/authz'
import { guardComplianceFeature } from '@/lib/compliance'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

type Action = 'compute' | 'finalize' | 'file' | 'void'

const FILING_CHANNELS = new Set(['iris', 'fire', 'paper', 'provider', 'other'])

/**
 * Drive a filing through compute → finalize → filed.
 *
 * `compute` is bookkeeping and needs `compliance.manage`. `finalize` and `file`
 * commit the organisation to a statutory position and need `compliance.file` —
 * whoever prepares the worksheet is not necessarily authorised to transmit it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const blocked = await guardComplianceFeature(authz.user.orgId)
  if (blocked) return blocked
  const { orgId, id: actorId } = authz.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as {
    action?: Action
    channel?: string
    reference?: string | null
    reason?: string
  }
  const action = body.action
  if (!action) return NextResponse.json({ error: 'action is required' }, { status: 400 })
  const needed = action === 'compute' ? 'compliance.manage' : 'compliance.file'
  if (!can(authz, needed)) {
    return NextResponse.json({ error: `missing permission: ${needed}` }, { status: 403 })
  }

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
      // A filed return is not un-filed by voiding our record of it; the void is
      // the internal note that a corrected filing supersedes it.
      const updated = (await db.execute(sql`
        update information_return_filings
           set status = 'void', void_reason = ${reason}, updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${id} and status <> 'void'
        returning id`)) as unknown as { rows: { id: string }[] }
      if (updated.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 })
    } else {
      return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
    await db.execute(sql`
      insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'information_return_filings', ${id}, ${action},
              ${JSON.stringify({ after: body })}::jsonb, ${actorId})`)
    return NextResponse.json({ id })
  } catch (e) {
    const status = e instanceof InformationReturnError ? 422 : 500
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status })
  }
}
