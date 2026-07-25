import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '@/lib/authz'
import { guardLienWaiverFeature } from '@/lib/compliance'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

type Action = 'request' | 'receive' | 'sign' | 'reject' | 'void' | 'update'

/** Forward-only lifecycle. A waiver never walks back into an earlier state. */
const ALLOWED_FROM: Record<Action, string[]> = {
  request: ['draft'],
  receive: ['draft', 'requested'],
  sign: ['draft', 'requested', 'received'],
  reject: ['requested', 'received'],
  void: ['draft', 'requested', 'received', 'signed', 'rejected'],
  update: ['draft', 'requested', 'received'],
}

/**
 * Drive one lien waiver through its lifecycle.
 *
 * `sign` is the consequential transition — it is what releases a blocked
 * payment — so it demands the signatory's name and the date they signed, and it
 * stamps who in this organisation attested to receiving the executed document.
 * A signed waiver is then immutable except for voiding: editing the amount or
 * through-date of an executed release would silently change what a
 * subcontractor gave up.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('compliance.manage')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardLienWaiverFeature(gate.user.orgId)
  if (blocked) return blocked
  const { orgId, id: actorId } = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json()) as {
    action?: Action
    signedByName?: string
    signedByTitle?: string | null
    signedAt?: string
    notarized?: boolean
    reason?: string
    throughDate?: string
    amount?: string
    jurisdiction?: string | null
    notes?: string | null
  }
  const action: Action = body.action ?? 'update'

  const before = (await db.execute(sql`
    select id, status, waiver_number, waiver_type, through_date, amount, currency, direction
      from lien_waivers where org_id = ${orgId} and id = ${id}
  `)) as unknown as { rows: Record<string, unknown>[] }
  const waiver = before.rows[0]
  if (!waiver) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!ALLOWED_FROM[action].includes(String(waiver.status))) {
    return NextResponse.json(
      { error: `a ${waiver.status} waiver cannot be ${action === 'update' ? 'edited' : action + 'ed'}` },
      { status: 422 },
    )
  }

  try {
    if (action === 'request') {
      await db.execute(sql`
        update lien_waivers
           set status = 'requested', requested_at = now(), requested_by = ${actorId},
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${id}`)
    } else if (action === 'receive') {
      await db.execute(sql`
        update lien_waivers set status = 'received', updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${id}`)
    } else if (action === 'sign') {
      const name = (body.signedByName ?? '').trim()
      if (!name) {
        return NextResponse.json({ error: 'the name of the person who signed is required' }, { status: 400 })
      }
      const signedAt = body.signedAt ?? new Date().toISOString().slice(0, 10)
      // Evidence of the attestation, not a digital signature: who in this
      // organisation recorded the executed document, and when.
      const evidence = {
        method: 'recorded_in_app',
        attestedBy: actorId,
        attestedAt: new Date().toISOString(),
        signedByName: name,
        signedByTitle: body.signedByTitle ?? null,
      }
      await db.execute(sql`
        update lien_waivers
           set status = 'signed', signed_by_name = ${name},
               signed_by_title = ${body.signedByTitle ?? null},
               signed_at = ${`${signedAt}T00:00:00Z`}::timestamptz,
               notarized = coalesce(${body.notarized ?? null}, notarized),
               signature = ${JSON.stringify(evidence)}::jsonb,
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${id}`)
    } else if (action === 'reject') {
      const reason = (body.reason ?? '').trim()
      if (!reason) return NextResponse.json({ error: 'a rejection needs a reason' }, { status: 400 })
      await db.execute(sql`
        update lien_waivers
           set status = 'rejected', rejected_reason = ${reason},
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${id}`)
    } else if (action === 'void') {
      const reason = (body.reason ?? '').trim()
      if (!reason) return NextResponse.json({ error: 'voiding needs a reason' }, { status: 400 })
      await db.execute(sql`
        update lien_waivers
           set status = 'void', void_reason = ${reason}, updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${id}`)
    } else {
      await db.execute(sql`
        update lien_waivers
           set through_date = coalesce(${body.throughDate ?? null}::date, through_date),
               amount = coalesce(${body.amount ?? null}::numeric, amount),
               jurisdiction = coalesce(${body.jurisdiction ?? null}, jurisdiction),
               notes = coalesce(${body.notes ?? null}, notes),
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${id}`)
    }
    await db.execute(sql`
      insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'lien_waivers', ${id}, ${action === 'update' ? 'update' : action},
              ${JSON.stringify({ before: waiver, after: body })}::jsonb, ${actorId})`)
    return NextResponse.json({ id })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'save failed' }, { status: 400 })
  }
}
