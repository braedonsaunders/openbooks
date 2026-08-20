import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { formDefinition } from '@openbooks/engine/src/information-returns.ts'
import { guardPermission } from '@/lib/authz'
import { guardComplianceFeature } from '@/lib/compliance'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

const AMOUNT_RE = /^-?\d{1,15}(\.\d{1,4})?$/

/**
 * Adjust or exclude one recipient of a filing.
 *
 * Adjustments are stored as SIGNED DELTAS against the computed figure, never as
 * a replacement: the ledger trace stays intact and reviewable, and the filed
 * number is always computed + adjustment. Every adjustment carries a reason,
 * and a finalized filing refuses both — correct it with a corrected filing.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; recipientId: string }> },
) {
  const gate = await guardPermission('compliance.manage')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardComplianceFeature(gate.user.orgId)
  if (blocked) return blocked
  const { orgId, id: actorId } = gate.user
  const { id, recipientId } = await params
  if (!isUuid(id) || !isUuid(recipientId)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json()) as {
    adjustments?: Record<string, string>
    adjustmentReason?: string | null
    status?: 'included' | 'excluded'
    exclusionReason?: string | null
  }

  const rows = (await db.execute<{ id: string; status: string; adjustments: Record<string, string>; computed_amounts: Record<string, string>; filing_status: string; form_type: string }>(sql`
    select r.id, r.status, r.adjustments, r.computed_amounts, f.status as filing_status, f.form_type
      from information_return_recipients r
      join information_return_filings f on f.id = r.filing_id
     where r.org_id = ${orgId} and r.id = ${recipientId} and r.filing_id = ${id}
  `))
  const recipient = rows.rows[0]
  if (!recipient) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (recipient.filing_status !== 'draft' && recipient.filing_status !== 'computed') {
    return NextResponse.json(
      { error: `a ${recipient.filing_status} filing is frozen — open a corrected filing instead` },
      { status: 422 },
    )
  }

  const form = formDefinition(recipient.form_type)
  const validBoxes = new Set(form.boxes.map((b) => b.key))
  let adjustments = recipient.adjustments
  if (body.adjustments) {
    const cleaned: Record<string, string> = {}
    for (const [box, value] of Object.entries(body.adjustments)) {
      if (!validBoxes.has(box)) {
        return NextResponse.json({ error: `${box} is not a box on ${form.formType}` }, { status: 400 })
      }
      if (!AMOUNT_RE.test(String(value))) {
        return NextResponse.json({ error: `${box}: not a valid amount` }, { status: 400 })
      }
      if (Number(value) !== 0) cleaned[box] = String(value)
    }
    if (Object.keys(cleaned).length > 0 && !(body.adjustmentReason ?? '').trim()) {
      return NextResponse.json({ error: 'an adjustment needs a reason' }, { status: 400 })
    }
    adjustments = cleaned
  }

  const status = body.status ?? recipient.status
  if (status === 'excluded' && !(body.exclusionReason ?? '').trim()) {
    return NextResponse.json({ error: 'excluding a recipient needs a reason' }, { status: 400 })
  }

  try {
    await db.execute(sql`
      update information_return_recipients
         set adjustments = ${JSON.stringify(adjustments)}::jsonb,
             adjustment_reason = ${Object.keys(adjustments).length > 0 ? (body.adjustmentReason ?? '').trim() : null},
             status = ${status},
             exclusion_reason = ${status === 'excluded' ? (body.exclusionReason ?? '').trim() : null},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${recipientId}`)
    await db.execute(sql`
      insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'information_return_recipients', ${recipientId}, 'update',
              ${JSON.stringify({ before: { status: recipient.status, adjustments: recipient.adjustments }, after: { status, adjustments } })}::jsonb,
              ${actorId})`)
    return NextResponse.json({ id: recipientId })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'save failed' }, { status: 400 })
  }
}
